# Objective and Context

> Let's put in some abstraction so we can evaluate the core logic without an nvim client present.

Follow-up to the test-speed work: tests should come in two tiers (see `.magenta/skills/testing/skill.md`). Today most of glean's behaviour is only reachable through `*.driver.test.ts` (a headless nvim + backend per test, ~0.5–1s each), because the controllers that own it take an `Nvim` client and interleave decisions with RPC calls. The goal is that every decision glean makes is testable in node against real git repos, and nvim tests only cover the nvim-applied surface (keymaps firing, buffer text/extmarks, windows/floats, autocmds, Lua shim, backend lifecycle).

Key entities:
- `Session` (`node/session/session.ts`): model, seen store, collapse, undo/redo, ignore-whitespace. Already nvim-free.
- Pure planners (already nvim-free): `render` → `Frame`; `render/actions.ts` (`planToggleSeen`, `planVisualMark`, `planUnmarkHunk`, `planUnmarkAll`, `collapseTarget`, `nextUnseenHunk`, `rowOfHunk`); `render/nav.ts` (`navRow`, `hunkRange`, `jumpTarget`, `diffContext`, `sourceLineRow`, `fileHeaderRow`, `revealKeys`); `render/anchor.ts` (`cursorAnchor`, `restoreAnchor`); `render/commentActions.ts`; `gutter/project.ts`, `gutter/marking.ts`, `gutter/bufUndo.ts`; `overlay/project.ts`; `targets.ts` (`renderLog`, `logSelection`, …).
- Nvim-coupled controllers (the problem):
  - `node/view/view.ts` `ReviewView` (1200 lines): `dispatch(Action)` orchestrates planners + `Session` + redraw + cursor + editor/picker/notify + jump/diffsplit, and also owns painting (row-diffed set_lines, extmarks, intraline, hunk decor, sticky float).
  - `node/overlay/overlay.ts` `Overlay`: comment overlay on file buffers; already has an `OverlayHost` seam for store/undo, but reads buffers and writes extmarks/floats/editors via `Nvim` directly.
  - `node/gutter/fileGutter.ts` `FileGutter`: gutter paint/staleness, marking, per-buffer undo, `]c`, toggles, focus overlay.
  - `node/glean.ts`: command dispatch, review registry (one current review, default review for `:Glean jump`), `:Glean log`/`:Glean prs` list buffers and paging, reset/close.
  - `node/view/jump.ts`: live-vs-scratch jump resolution + window ops.
  - `node/view/prompts.ts` `Prompts`: token → callback for Lua editor/picker round-trips.

# Design

Ports and adapters. Each controller is split into:

1. **Core** (nvim-free class): owns the state and all decisions. It depends only on `Session`/`Store`/`Git` and a small **UI port** interface expressed in glean's own vocabulary (rows, frames, stamps, marks, cursor rows) — never raw nvim API names, ids of namespaces, or Lua snippets.
2. **Nvim adapter** implementing the port: all `nvim.call`s, batching (`MAX_BATCH_*`), namespaces, Lua helpers, the `Prompts` token plumbing. Adapters contain no decisions beyond "how to apply this to nvim".

In node tests the port is implemented by a tiny in-memory **recorder** (the last painted frame, cursor row, notifications, stamps, a queue of scripted editor/picker answers). This is not a fake nvim: it implements glean's own narrow interface, so it can't drift from nvim semantics — anything nvim-semantic stays behind the adapter and is covered by the driver tests.

Editor/picker become promise-returning port methods (`editor(initial): Promise<string | undefined>`, `pick(items): Promise<number | undefined>`). The nvim adapter keeps `Prompts` internally, resolving the promise when the `editor-submit`/`pick` action arrives (a dismissed editor resolves `undefined`); the core just awaits. This removes callback registration from the core and makes comment flows linear and testable.

Reads the core needs from nvim (buffer facts, lines, cursor/topline) also go through the port, returning plain data, so the core never parses Lua results.

Order: start with `ReviewView` (largest payoff, most driver tests), then overlay, gutter, then glean.ts registry/lists. Each stage moves its logic-level driver assertions into node tests and slims the driver test to a smoke check that the binding reaches the core.

## Interfaces

Sketches; the implementer should keep each port minimal — add a method only when a core decision needs it, and prefer passing plain data over callbacks. Exact names may be adjusted to fit, but ports must not mention nvim API concepts.

```ts
// node/view/review.ts — core
export type ReviewUi = {
  /** Show `frame` (adapter diffs rows, paints highlights/intraline, locks the buffer). */
  paint(frame: Frame): Promise<void>;
  setCursor(row: number): Promise<void>;
  notify(msg: string, level: "info" | "warn" | "error"): Promise<void>;
  editor(initial: string[]): Promise<string | undefined>;
  pick(items: string[]): Promise<number | undefined>;
  openJump(target: ResolvedJump, col: number): Promise<void>;
  openDiffsplit(ctx: DiffContext, ignoreWhitespace: boolean): Promise<void>;
  openFileAt(path: RepoPath, lnum: number): Promise<void>;
};
export class ReviewController {
  scope: Scope;
  frame: Frame | undefined;
  constructor(session: Session, ui: ReviewUi, opts: ViewOpts);
  dispatch(a: Action): Promise<void>;          // all non-display actions
  gotoSource(path: RepoPath, lnum: PostLnum): Promise<number | undefined>;
  redraw(): Promise<void>;                      // build frame → ui.paint
  query(q: Query): [number, number] | undefined; // unchanged, sync
}
```
`ReviewView` becomes the nvim adapter: implements `ReviewUi`, owns suspend/resume, decor (active hunk, indent timer, sticky float) and routes `visibility`/`cursor`/`sticky-close`/`editor-submit`/`pick` itself; everything else delegates to the controller. Decor decisions that are pure (`frameDecor`, `computeAncestry`/`computePinned`) stay pure functions with their own node tests.

```ts
// node/view/jump.ts
export type ResolvedJump =
  | { kind: "live"; path: RepoPath; lnum: number }
  | { kind: "scratch"; rev: string; path: RepoPath; lnum: number };
export function resolveJump(git: Git, jt: JumpTarget): Promise<ResolvedJump>; // git + fs only
```

```ts
// node/overlay/overlay.ts
export type BufFacts = { name: string; buftype: string; modified: boolean; seq: number };
export type OverlayUi = {
  fileBuffers(): Promise<number[]>;
  facts(buf: number): Promise<BufFacts | undefined>;
  lines(buf: number, lo?: number, hi?: number): Promise<string[]>;
  stamp(buf: number, stamps: Stamp[]): Promise<void>;   // clear + set
  activateUndo(buf: number): Promise<void>;
  park(buf: number, lnum: number): Promise<void>;
  float(buf: number, lines: string[]): Promise<void>;
  quickfix(items: QuickfixItem[]): Promise<void>;
  notify(msg: string, level: "info" | "warn" | "error"): Promise<void>;
  editor(buf: number, initial: string[]): Promise<string | undefined>;
  pick(buf: number, items: string[]): Promise<number | undefined>;
};
// Overlay(ui: OverlayUi, host: OverlayHost) — OverlayHost unchanged.
```

```ts
// node/gutter/fileGutter.ts
export type GutterUi = {
  infos(bufs: number[] | undefined, withSeq: boolean): Promise<BufInfo[]>;
  lines(buf: number): Promise<string[]>;
  paint(buf: number, marks: GutterMarks | undefined, stale: boolean): Promise<void>;
  focus(buf: number, range: { lo: WorktreeLnum; hi: WorktreeLnum } | undefined): Promise<void>;
  provider(buf: number, attached: boolean): Promise<void>; // suppress/restore foreign signs
  setUndoDepth(buf: number, depth: UndoDepth | undefined): Promise<void>;
  park(buf: number, row: number): Promise<void>;
  notify(msg: string, level: "info" | "warn" | "error"): Promise<void>;
};
// FileGutter(ui: GutterUi, session: () => Session | undefined)
```

```ts
// node/glean.ts → node/app.ts (core) + glean.ts (nvim wiring)
export type AppUi = {
  config(): Promise<OpenConfig>;              // OPEN_CONFIG_LUA result, parsed
  openReviewBuffer(title: string): Promise<number>;
  showBuffer(buf: number): Promise<void>;
  wipeBuffer(buf: number): Promise<void>;
  paintList(buf: number, frame: ListFrame, cursor?: number): Promise<void>;
  notify(msg: string, level: "info" | "warn" | "error"): Promise<void>;
  reviewUi(buf: number): ReviewUi;
};
export class App {  // registry: current review, reviews, liveSession, list states
  command(cmd: Command): Promise<void>;
  action(buf: number, a: Action): Promise<void>;
  list(buf: number, ev: ListEvent): Promise<void>;
  jump(path: string, lnum: number): Promise<void>;
}
```
Only extract `App` state/decisions that driver tests currently exercise (one review at a time, default review for `:Glean jump`, log paging/selection, wiped list buffers, range titles); leave RPC registration and backend lifecycle in `glean.ts`.

Test helper (node-only): `node/test/ui.ts` with recorder implementations of each port (`recordReviewUi()`, `recordOverlayUi(buffers)`, `recordGutterUi(buffers)`) exposing `frame`, `cursor`, `notes`, `stamps`, … and `answer(text | index | undefined)` queues for editor/pick. Buffers in overlay/gutter recorders are plain `{ name, lines, modified, seq }` records the test mutates directly (simulating edits/writes), backed by files in the real repo when disk matters.

## Invariants

- Behaviour is unchanged: every existing driver test keeps passing through the adapter throughout the refactor; only after a stage's node tests cover a behaviour is the driver test slimmed.
- Cores contain no `nvim.call`, no Lua strings, no namespace ids, no `MAX_BATCH_*`; adapters contain no planners/Session mutations.
- Serialization is preserved: the `enqueue` chains in `Overlay`/`FileGutter` and `drawChain`/`decorChain` in the view keep their ordering guarantees (they live in the core where they guard state, in the adapter where they guard nvim writes).
- Staleness guards (`jumpGuard`, `intraGuard`, `allGen`, `GenerationGuard`) keep their semantics; a stale jump never moves windows or the cursor.
- Awaiting `editor()`/`pick()` must not block other events: the core awaits inside the action's own task, and the nvim adapter resolves on `editor-submit`/`pick` which arrive as separate notifications — make sure the dispatch path doesn't serialize the submit behind the pending editor (today `Prompts.submit` runs outside any chain; keep it that way).
- A dismissed editor (no submit) must not leak: the adapter resolves `undefined` on editor close, or at minimum the pending promise is dropped with the token.
- `query()` stays synchronous and await-free (nvim blocks on it).
- Undo semantics: `FileUndo` comment entries still run through the overlay's chain; `b:glean_undo` still mirrors the stack depth.

# Stages

## Review controller

- Goal: `ReviewController` (core) + `ReviewView` (nvim adapter implementing `ReviewUi`), `resolveJump` split out of `openJump`, `recordReviewUi` test helper. All view/glean driver tests still pass.
- Tests (node-only, `node/view/review.test.ts`, real repos + `Session`):
  - `m` on a hunk marks it, repaints, and lands the cursor on the next unseen hunk; on the last hunk the cursor clamps.
  - visual mark, unmark-hunk, `U` unmark-all; `u`/`<C-r>` restore seen state and cursor row.
  - `=` collapses/expands; `S` toggles scope keeping the cursor on the same line identity and expands a collapsed destination file.
  - `W` round-trips whitespace projection keeping the cursor.
  - comments: `c` with a scripted editor answer adds a comment (inline + summary rows); dismissing the editor adds nothing; `i` with unchanged text pushes no undo; `dd`; `dc` with two comments asks `pick` with both texts and deletes the picked one; visual `d` over the summary removes all as one undo step; `c` on an uncommentable row notifies.
  - `<CR>` on a summary file row moves the cursor to the header; on a summary comment reveals it (expanding a seen/collapsed file; switching back from ignore-whitespace for a hidden one); on an off-diff comment calls `openFileAt`.
  - `<CR>`/`D` on diff rows call `openJump`/`openDiffsplit` with the resolved target; a superseded jump (second `<CR>` before the first resolves) never calls the port.
  - `gotoSource` reveals a line in a collapsed seen file and returns undefined for files outside the review.
  - `resolveJump` (`node/view/jump.test.ts`): live when the target is HEAD or the committed line maps through the worktree to identical text, scratch otherwise.
  - Then slim `view.driver.test.ts` / `glean.driver.test.ts` to: keymaps reach the controller (one smoke per key family), buffer paint incl. intraline extmarks, hunk indent timer, sticky float, suspend/resume, responsiveness under a huge hunk.

- Status: done.
  - `node/view/review.ts`: `ReviewController` + `ReviewUi` (also owns `Action`/`Query`/parsers, re-exported from `view.ts`); `ReviewView` is the adapter and exposes `controller`.
  - Deviations: `ReviewUi` gained `worktreeLine: LineReader` (so `resolveJump` still prefers unsaved buffer text; the recorder uses disk) and `openJump`/`openDiffsplit` take the `isStale` check (the adapter's scratch loading is async and must drop superseded windows). `ResolvedJump` is `{ kind: "live" | "scratch"; path; lnum; rev }` (`rev` is the fallback when the live file fails to open). Diffsplit resolution (live right side) stays in the adapter's `openDiffsplit`. The controller has a `live` flag the adapter clears while hidden so model changes skip repaints.
  - `Prompts` is promise-based; the Lua editor/picker now reply without a value when dismissed (resolves `undefined`, no leak). The overlay uses it too, running the answer's continuation via its own `enqueue`.
  - Review follow-up: `ResolvedJump` is a union — `live` has `lnum: WorktreeLnum` plus `fallback: { rev; lnum: PostLnum }` (the blob opened if the live file fails; now the committed line, not the mapped one), `scratch` has `rev` and `lnum: PostLnum | PreLnum`. Prompt tokens are branded at the parse boundary (`toPromptToken`); `PromptResult` is the shared editor-submit/pick union. `openFileAt` takes `WorktreeLnum`. Added parse tests for missing text/index (prompts.test.ts) and an overlay driver test for a cancelled editor and dismissed picker. The `gj` file-buffer map (→ `:Glean jump`) is left without driver coverage.
  - Not covered in node: `<CR>` on an off-diff comment (`openFileAt`) and the ignore-whitespace-hidden summary comment (still in `glean.driver.test.ts`).
  - Driver tests removed: view "m lands on next unseen hunk", "toggle-scope expands a collapsed destination"; glean "W round-trips", "<CR> on a summary comment reveals a seen file", ":Glean jump reveals a line of a collapsed seen file", "visual c / dc / visual d".

## Overlay

- Goal: `Overlay` takes `OverlayUi`; nvim adapter `node/overlay/nvimOverlayUi.ts`; `recordOverlayUi`.
- Tests (node-only, `node/overlay/overlay.test.ts`):
  - refresh stamps resolved comments; editing buffer lines re-resolves and persists a moved lnum; deleting the line marks it outdated; an api write followed by `refreshAll` re-stamps.
  - a buffer with no comments gets no stamps and no `activateUndo`.
  - add on a line and on a range (origin HEAD vs dirty vs no-HEAD worktree); edit, reply (fill, replace), delete-with-pick; each pushes exactly one undo entry whose `run(true)`/`run(false)` round-trips the store; unchanged edit pushes nothing; undo/redo of an add keeps the same id.
  - show/jump/quickfix produce the expected float lines, park row, quickfix items.
  - outside a repo, add only notifies.
  - Then slim `overlay.driver.test.ts` to: stamps render as extmarks/virt_lines, inline toggle, float window, `u`/`<C-r>` wiring on the file buffer, editor split + picker round-trip, quiet-file has no maps.

- Status: done.
  - `OverlayUi` lives in `overlay.ts`; the adapter is `NvimOverlayUi` (`nvimOverlayUi.ts`, owns the namespace, batching, Lua and `Prompts`). `recordOverlayUi(buffers, cwd)` in `node/test/ui.ts`; tests in `overlay.test.ts`.
  - Deviations: the port also has `cwd()` (quickfix outside a file buffer), `logError`, and `pick(items, title)`; `float` takes `BodyLine[]` (no buf); `editor` takes no buf. Editor/pick answers are routed by `glean.ts` straight to `NvimOverlayUi.submit` (outside the overlay chain); `Overlay.handle` no longer accepts `PromptResult`. The core calls `ui.editor`/`ui.pick` without awaiting and enqueues the continuation on answer, so the chain is never blocked by an open prompt.
  - Driver tests removed (now node-only): outdated/api re-stamp/quickfix, authoring line/range, edit undo/unchanged edit, reply, add undo/redo id, outside-repo.
  - Review follow-up: `OverlayUi.lines` split into `allLines(buf)` and `range(buf, {from, to})` (1-based inclusive `WorktreeLnum`s; the adapter converts to 0-based). Buffer handles in overlay events and the port are `BufNr` (branded at `parseOverlayEvent`); `park` takes a `WorktreeLnum`.

## Gutter

- Goal: `FileGutter` takes `GutterUi`; nvim adapter; `recordGutterUi`.
- Tests (node-only, `node/gutter/fileGutter.test.ts`):
  - paints marks for a worktree buffer; a modified buffer paints stale; revert repaints fresh.
  - `gmm`/range/`gmc` mark via the session and push undo; undo/redo restore; `setUndoDepth` mirrors the stack; a novel edit (seq change) wipes the stack; a write + session refresh reconciles.
  - uncommitted deletions mark/unmark; `]c` parks on next/prev hunk start within bounds.
  - per-buffer toggle and global `setEnabled` stop painting and restore the foreign provider; re-enabling reattaches.
  - focus reports the hunk range under the cursor.
  - Then slim `gutter.driver.test.ts` to: signs appear as extmarks, focus glyph, keymaps reach the core, foreign provider detach/reattach on backend exit.

- Status: done.
  - `GutterUi` + `GutterPaint`/`GutterSign` live in `fileGutter.ts`; the adapter is `NvimGutterUi` (`nvimGutterUi.ts`: namespaces, glyphs/highlight groups, batching, Lua `info`/`attach`/`detach`, park). `recordGutterUi(buffers)` in `node/test/ui.ts`; tests in `fileGutter.test.ts`.
  - Deviations: instead of separate `paint`/`provider` per buffer, `paint(paints[])` takes one batch of `{ buf, member: "attach"|"detach"|undefined, signs, stale, focus }` (the adapter keeps it one atomic write); `focus(buf, signs)` takes the computed focus signs (pure `focusSigns` in the core). The port also has `logError`. `setUndoDepth` is only called with a defined depth (as before).
  - Driver tests removed (now node-only): gm2j range, write-reconcile/novel-edit stack wipe.
  - Review follow-up: `GutterPaint` is `{ buf, member, state }` with `state` a union `clear | stale { lnums } | live { signs, focus }`. Buffers across the port/events are `BufNr` (branded at `parseGutterEvent`/`parseInfos`); `park` takes `WorktreeLnum` (so `FileUndo` comment cursors and overlay event lnums are `WorktreeLnum`, branded at `parseOverlayEvent`). `infos(bufs)` no longer takes `withSeq`; `seqInfo(buf)` returns `SeqInfo` with a guaranteed `seq`. The driver test keeps `:Glean toggle-gutter` and `1Glean toggle-mark` on d.txt (command → range forwarding); stale signs are already covered by the driver paint test. The novel-edit node test now asserts the stack depth is reset.

## App registry and lists

- Goal: `App` core in `node/app.ts` with `AppUi`; `glean.ts` keeps RPC wiring/lifecycle and implements `AppUi`.
- Tests (node-only, `node/app.test.ts`):
  - opening a second review replaces the first (one review at a time); reopening the same key reuses the buffer.
  - `:Glean jump` with no review opens the default one; a file outside warns.
  - `:Glean log` paging (page size, "more" footer, stops at end), `<CR>` and visual `<CR>` resolve to the right review, a wiped list buffer is forgotten.
  - range reviews get the expected title.
  - Then slim `glean.driver.test.ts` to: bridge ping/teardown, list buffer paint + `]p`/`<CR>` wiring.

## Docs

- Goal: update `.magenta/skills/testing/skill.md` (port/recorder pattern, where each kind of test goes) and the Layout section of `context.md`.
- Tests: full suite green; `npx tsc -p .`, `npx biome check .`; every test < 1s in the parallel suite, driver test count roughly halved.
