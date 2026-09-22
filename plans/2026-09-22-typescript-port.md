# Objective and Context

User request: "Glean ended up crashing a couple of my neovim sessions [...] Both are stuck in the glean plugin's intra-line diff highlighting, running synchronously on the main Lua thread. [...] I want to make this impossible to happen again. Glean should never run anything in the main thread so that even if it gets stuck or is doing something computationally expensive, we should run that in an isolated way (so that Glean is safe to run in any session)." Then: "I'm actually feeling that it's about time we switched to a different language that has better semantics for this so I want to use TypeScript. See how ~/src/magenta.nvim/ is set up with the lua part vs the node process. Set it up exactly the same way. You can copy/paste all the nvim communication stuff. Then convert the code into typescript. Do your best to leverage the type system - make the types non-representative. Actually, add some review guidance for this in the same way magenta does. Write up a plan"

## Diagnosis being fixed

- `intraline.pair_lines` scores every del×add pair with a full token DP (`M.align`), so one block costs about m·n·|ta|·|tb| time plus allocation. That is what caused the 3 GB spin.
- `INTRA_BUDGET` in `init.lua` counts `#dels + #adds` and is only checked between blocks. A single `refine` call can't be interrupted.
- Git runs through `vim.system(...):wait()`, which blocks the UI whenever git is slow.
- The root cause is that all compute and IO share the nvim main loop. Moving to a node process removes this by construction: nvim only ever handles RPC notifications and buffer or extmark writes.

## Reference: magenta's split (to copy)

- `lua/magenta/init.lua`:
  - `M.start` runs `jobstart({"node", dist/magenta.mjs})`, or in dev mode (`MAGENTA_DEV=1`) runs source via `--experimental-transform-types --import boot.mjs index.ts`.
  - `M.bridge(channelId)` is called back by node. It registers the user command and autocmds in a named augroup, and forwards them through `safe_rpcnotify`.
  - `M.teardown_bridge` runs on job exit or a dead channel. A `VimLeavePre` autocmd calls `jobstop`.
- `node/nvimclient/index.ts`: reads `process.env.NVIM` and calls `attach({socket})` from `nvim/nvim-node`. Handles SIGTERM.
- `node/nvimclient/nvim/nvim-node/`: `attach.ts`, `types.ts`, `neovim-api.types.ts`, `logger.ts` and the `cli/generate.ts` typed-API generator. These are copied verbatim.
- `node/nvimclient/nvim/{nvim.ts,buffer.ts,window.ts,extmarks.ts}`: typed buffer, window and extmark helpers. Copied, then trimmed to what glean uses.
- `node/nvimclient/test/driver.ts` and `setup.ts`: vitest with a real embedded nvim. The pattern is copied.
- `scripts/build.mjs` (esbuild bundle to `dist/*.mjs`), `tsconfig.json` (strict, `exactOptionalPropertyTypes`, `.ts` imports, `noEmit`), `biome.json`, `vitest.config.ts`, and the `pre-commit` hook.
- `.github/instructions/*.instructions.md`: review guidance consumed by the `code-review` script.

## Glean today (~10k src lines, ~10k test lines, Lua)

- `init.lua` (5.5k): setup, `:Glean`, model build, renderer, `row_map`, actions and keymaps, polling, and both scopes.
- Pure modules: `diff`, `intraline`, `baseline`, `provenance`, `ignore`, `lineage`, `overlay`, `comments`, `dirtree`.
- IO modules: `git` (injectable runner), `state` (sharded JSON store), `gutter`, `bufundo`, `api` (agent JSON surface over `nvim_exec_lua`).

# Design

Glean gets a single node process per nvim, laid out like magenta but as one flat package (no workspaces, no core/nvim split).

- The **Lua side is thin**: start and bridge, the `:Glean` command, keymaps that `rpcnotify` an action name plus cursor row, autocmds (BufEnter/TextChanged/BufWritePost/CursorMoved on file buffers), and the `api.lua` shim. Lua never computes anything. Every handler is O(1) plus one rpcnotify.
- The **node main thread** owns the model, review store, `row_map`, collapse state and scheduling. It renders by sending batched `nvim_buf_set_lines` and extmark calls (via `nvim_call_atomic`, or one `nvim_exec_lua` chunk per batch) to a nomodifiable scratch buffer. Its event loop must stay responsive so that RPC requests (the api surface) return quickly.
- **Heavy pure work** (`intraline.refine`, blame parsing, baseline classification) runs on the node event loop. Node being a separate process is the isolation: a slow computation delays glean's own responses, never nvim. To keep node responsive to RPC, long batches are chunked with `setImmediate` yields between blocks, and a generation counter drops stale results.
- **Git** is async only: `child_process.spawn` wrapped in an injectable `GitRunner`, with per-call timeouts and a poll that won't overlap itself.
- **Algorithmic caps stay** in intraline (m·n cell cap, token-product cap, and a length-ratio pre-filter) so no single block monopolizes the event loop.

The agent API (magenta's `nvim_exec_lua` calls into `require("glean.api")`) keeps its Lua entrypoints. Each one becomes `vim.rpcrequest(channel, "glean.api", name, args)`. Because rpcrequest blocks nvim until node replies, node serves these from in-memory state only. Anything that needs git or fresh computation returns `{status: "pending"}` or awaits with a short timeout. The skill doc is updated to match.

## Interfaces

Core types, written to follow the new review guidance:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type Sha = Brand<string, "Sha">;
type RepoPath = Brand<string, "RepoPath">;
type HeadLnum = Brand<number, "HeadLnum">;      // line in the tip commit H
type WorktreeLnum = Brand<number, "WorktreeLnum">;
type PostLnum = Brand<number, "PostLnum">;      // post-image of a commit
type PreLnum = Brand<number, "PreLnum">;

type LineId =
  | { kind: "committed-add"; sha: Sha; lnum: PostLnum }
  | { kind: "committed-del"; removerSha: Sha; lnum: PreLnum }
  | { kind: "worktree-add"; path: RepoPath; lnum: WorktreeLnum }
  | { kind: "worktree-del"; path: RepoPath; lnum: HeadLnum };

type DiffLine =
  | { kind: "ctx"; text: string; oldLnum: number; newLnum: number }
  | { kind: "add"; text: string; newLnum: number }
  | { kind: "del"; text: string; oldLnum: number };

type Scope = { kind: "combined" } | { kind: "commits" };

type RowTarget =
  | { kind: "commit-header"; sha: Sha }
  | { kind: "file-header"; owner: Owner; path: RepoPath }
  | { kind: "hunk-header"; owner: Owner; path: RepoPath; hunk: number }
  | { kind: "line"; owner: Owner; path: RepoPath; hunk: number; li: number; id: LineId }
  | { kind: "seen-marker"; ids: readonly LineId[] }
  | { kind: "blank" };
type Owner = { kind: "commit"; sha: Sha } | { kind: "worktree" };

type WorktreeRecord = {
  head: ContentHash;              // anchor on H's content
  baseline: readonly string[];    // R, invariant: diff(H, R) is add-only
  dels: RangeSet<HeadLnum>;
};

type Action =                     // everything lua can send
  | { kind: "toggle-seen"; row: number; count: number }
  | { kind: "toggle-fold"; row: number }
  | { kind: "toggle-scope" }
  | { kind: "comment"; row: number; text: string }
  /* ...one variant per current keymap action */;

interface GitRunner { run(args: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<GitResult> }
type GitResult = { kind: "ok"; stdout: string } | { kind: "error"; code: number; stderr: string } | { kind: "timeout" };
```

On disk, the store keeps its current JSON shape, so existing `<dir>/<sha>.json` shards load unchanged. It's parsed at the boundary by hand-written validators into the branded types.

Lua ↔ node:

- lua → node, notification: `glean.action(sessionId, Action)`, `glean.event(kind, bufnr)`, `glean.command(args)`.
- lua → node, request: `glean.api(name, args)`, which returns JSON.
- node → lua: plain nvim API calls. There are no custom Lua callbacks except `require("glean").bridge(channelId)`.

## Invariants

- No Lua code path does more than constant work plus an rpcnotify. Rendering batches are bounded in size.
- The node main thread never runs an unbounded pure computation. Superlinear work is capped per block and yields between blocks.
- Every git call has a timeout. Polls never overlap.
- Stale results (generation mismatch) are dropped, never applied.
- If node crashes, the nvim session keeps working (bridge teardown as in magenta). The review buffer shows "glean: backend exited" instead of erroring.
- Existing persisted stores stay readable. All seen-model semantics in `context.md` are preserved exactly (identity kinds, baseline algebra, `min_seen_run` demotion, sticky overrides, `.gleanignore` derived-seen, scope-toggle cursor preservation).
- Line identities are equal across scopes. The ported lineage and provenance tests must still pass.

# Stages

## Scaffold and review guidance

- Goal: `:Glean` starts a node process that bridges back and echoes the command. Tooling works.
- Work:
  - Copy `nvim-node/`, `nvim.ts`, `buffer.ts`, `window.ts`, `extmarks.ts`, `boot.mjs`, `index.ts` (trimmed), `scripts/build.mjs`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, the test driver and `pre-commit`.
  - Write the Lua `start`/`bridge`/`teardown_bridge`/`safe_rpcnotify` from magenta's `init.lua`.
  - Add `.github/instructions/`:
    - `type-representation.instructions.md`, copied and extended with glean examples: `LineId` union instead of `{sha?, path?, lnum}`, branded lnums so a head line can't be passed where a work-tree line is expected, `RowTarget` instead of nullable fields.
    - `general-typescript.instructions.md` and `test-coverage.instructions.md`, adapted.
    - `no-main-thread-compute.instructions.md` (new): flags any Lua work beyond dispatch, any synchronous superlinear work on the node main thread, and git calls without a timeout.
- Tests: a driver test starts nvim, runs `:Glean ping`, and asserts node received it. Killing node leaves nvim usable and removes `:Glean`.
- Status: done (05042d0), reviewed clean.
  - Layout: flat `node/` (`index.ts`, `glean.ts`, `boot.mjs`, `nvim/` with `nvim-node/` copied verbatim and `buffer.ts`/`window.ts`/`extmarks.ts`/`nvim.ts` trimmed of magenta-specific helpers), `node/test/driver.ts` (`withNvim`, `startBackend`, `pollUntil`), `scripts/build.mjs` → `dist/glean.mjs` (gitignored), `tsconfig.json`, `biome.json`, `vitest.config.ts`, `pre-commit`. Commands: `npx tsc -p .`, `npx vitest run`, `npx biome check .`, `npm run bundle`.
  - Deviation: until cutover the Lua implementation still owns `:Glean`, so the bridge lives in `lua/glean/node.lua` and registers `:GleanNode` (the ping test runs `:GleanNode ping`; the crash test asserts `:GleanNode` is removed). Node is started explicitly via `require("glean.node").start()`, not from `setup`. Rename to `:Glean` and wire into `setup` at cutover.
  - `start` sets `env.NVIM = vim.v.servername` (starting a server if needed): an inherited `$NVIM` (nvim run from a `:terminal`, or tests run under another nvim) otherwise attaches node to the wrong instance. magenta has the same latent bug.
  - Test driver is a small fresh `withNvim` (headless nvim with the repo on rtp, `GLEAN_DEV=1`) rather than magenta's full preamble; tests exercise the real Lua `start` → node → `bridge` path.
  - Review guidance: `.github/instructions/{general-typescript,test-coverage,type-representation,no-main-thread-compute}.instructions.md`.

## Pure module port

- Goal: `diff`, `intraline` (with caps), `baseline`, `provenance`, `ignore`, `lineage`, `overlay`, `comments`, `dirtree` and `state` are ported using the types above.
- Tests: port every `*_test.lua` case to vitest one-for-one; the existing tests are the spec. Add intraline tests with a synthetic 2000×2000 block of long lines that finishes in under 200 ms and still pairs obviously similar lines. `state` loads fixture shards written by the current Lua version.
- Note: `baseline` uses `vim.diff`. Replace it with the `diff` npm package (already one of magenta's dependencies) or a small Myers implementation, and check alignment parity on the existing baseline tests, including repeated-line cases.
- Status: done. Modules live in `node/core/` with colocated `*.test.ts`; `node/test/repo.ts` ports `testutil.make_repo`.
  - `types.ts`: brands (`Sha`, `RepoPath`, `HeadLnum`, `WorktreeLnum`, `PostLnum`, `PreLnum`, `ContentHash`), `WORKTREE`/`Layer`, and the `LineId` union (each variant also carries `path`).
  - `diff.ts`: `DiffLine` kinds are `context`/`add`/`del`; a del keeps its post-image slot `newLnum` (the Lua tests rely on it).
  - `intraline.ts`: segment cols are UTF-8 byte offsets; a non-word *code point* (not byte) is one token. Caps: `MAX_TOKEN_PRODUCT` per `align`; `MAX_PAIR_CELLS` above which `pairLines` switches to a banded greedy pass (window `MAX_PAIR_CELLS / dels`, stops at the first ≥0.8 match); a per-block `MAX_BLOCK_ALIGN_CELLS` budget of DP cells; and two exact pre-filters that skip alignment when the similarity can't clear the threshold (length ratio, and token-multiset overlap). 2000×2000 blocks (similar and unrelated) finish well under 200 ms. `is_current` is not ported; generation filtering belongs to the scheduler (stage 3).
  - `linediff.ts`: own Myers diff (no new dependency), dels before adds within a change region. `baseline.ts` exports `align` over it; `seen_adds` became `unseenAdds` (a set). All baseline tests pass unchanged, plus a randomized minimality/reconstruction test.
  - `lineage.ts`: the open tail is `n: "open"`, not a nil length. `base` is a lookup function. Every Lua lineage test is ported, including the real-repo content checker, randomized histories, and the blame oracle (`provenance.lua` no longer exists; the blame parser lives in the test as it did in Lua).
  - `ranges.ts` + `state.ts`: an async `Store` (`node:fs/promises`). Shards are validated at load and serialized back into the Lua JSON shape (so Lua and node can share a store dir until cutover). Hashes match `vim.fn.sha256`. Dropped on purpose because nothing live reads them: per-line commit comments (`add_comment`/`comments_at`), `range_adapter`, `wt_file`/`wt_*comment*`, and the legacy worktree `files`/`seen_marks` data (dropped on the next save). Legacy comments with bare-string `content` and `anchor` load as `add` entries with `lnum = anchor` (Lua silently read these as empty). `resolve` indices are 0-based, and the default `lnumOf` is index+1, so tiebreaks match Lua. Fixture shards written by Lua live in `node/core/fixtures/lua-store/`, regenerated by `generate-lua-store.lua`.
  - `comments.ts`: only the pure half (projections and `locate`, which returns a `found | outdated` union). The context/registry/editor half is nvim-facing and moves with overlay.
  - `dirtree.ts`: `dir_layout` pulled out of `init.lua`. Only the pure layout cases of `dirtree_test` are ported here; the rendering and action cases go with stage 4.
  - Review follow-up: `linediff` caps the Myers edit distance (`MAX_EDIT_DISTANCE`, and (N+M)·D ≤ 2e7) and stores only the -d..d band per round; above the cap the middle becomes one del block then one add block. This bounds `baseline` calls too; yielding between paths is left to the stage-3 scheduler. `state` commit keys are `Layer`, `CommentOrigin.sha` is `Sha`, lineage commit origins carry `PostLnum`. Deferred nits: `CommentEntry.oldLnum` stays `number` (it's content-addressed comment data, not a seen coordinate), `LineOp` isn't made generic over brands, and the `resolve` scan has no cap (comment counts are small; revisit if the api exposes it on hot paths).
  - Deferred: `overlay.lua` is all nvim UI (tier-3 tests of signs, floats, the editor and undo), so it moves with the gutter/file-buffer stage.

## Async git and scheduling

- Goal: `git.ts` runs on an injectable async `GitRunner` with timeouts. The refine scheduler yields between blocks and filters by generation.
- Tests:
  - A fake runner covers the git_test cases.
  - During a large refine, an RPC request interleaves (it is answered before the refine finishes).
  - A stale-generation response is dropped.
- Status: done. Code in `node/git/`.
  - `git.ts`: `GitRunner`/`GitResult` (`ok | error | timeout`), `spawnRunner(env?)` (pins the diff prefix config, SIGKILLs on timeout, optional stdin), and an all-async `Git` whose fallible methods return `Outcome<T>` (`ok | error`). The Lua sync/async pairs collapsed into one async method each; optional `path`/`ignoreWhitespace` go in a `DiffOpts` object. `join` wasn't ported (`Promise.all` replaces it). `emptyTree` uses `hash-object --stdin` instead of a temp file. `showMany` always uses one `cat-file --batch` process, including under injected runners.
  - `Poller`: an interval whose `poke()` is a no-op (returns false) while a tick is still in flight.
  - Review follow-up: `Outcome` gained a `timeout` variant (git timeouts are no longer folded into `error`). `poll()`, `untrackedSig()`, `showMany()` and the `line()` helpers (`remoteUrl`/`currentBranch`/`upstream`/`defaultTrunk`/`commonDir`) now return `Outcome`, so a failure is never mistaken for a clean tree or "no upstream". `showMany` yields a per-path `found | missing` map. `PollResult.head` is `Sha`; `LogCommit.shortSha` is a branded `ShortSha`; parsers use named groups instead of `!`. `parseLogPatches` yields to the loop every 50 commits. `untracked` stats first and substitutes a one-line placeholder for files over `MAX_UNTRACKED_BYTES` (1 MB). `refine` already enforces its own caps, noted at the `runRefine` call. New tests: multi-byte blobs with a missing path mid-stream, binary/empty/huge untracked files, timeouts surfacing as `timeout`, and a Poller recovering after a rejected tick.
  - `scheduler.ts`: `GenerationGuard` (`bump`, `isCurrent`, `settle(gen, promise, apply)` drops stale async results) and `runRefine`, which refines one block per `setImmediate` macrotask and stops once the generation moves on. The refine cache (`_intra_cache`) moves with the renderer in stage 4.
  - Tests: `git.test.ts` ports every git_test case against real fixture repos (`TestRepo` now exposes `env`), plus timeout, poll and non-overlap cases. `scheduler.test.ts` covers a timer macrotask answered mid-refine (standing in for an RPC request; the real nvim round trip is the stage-4 driver test) and dropping stale results.

## Model, renderer and actions

- Goal: port `init.lua` as `session.ts` (model build, refresh, polling), `render.ts` (pure `Model -> {lines, highlights, rowMap}`), `actions.ts` (a reducer over `Action`) and `nvimView.ts` (applies render output in bounded batches and diffs against the previous frame so it doesn't rewrite the whole buffer). Keymaps are defined in Lua and dispatch `Action`s.
- Tests: port `init_test`, `scope_cursor_test`, `reload_test`, `suspend_test`, `marker_test`, `dirty_combined_test` and `wt_dup_lines_test`, mostly against the pure renderer and reducer. A driver test checks the keymap → action → buffer round trip. A driver test with a huge generated hunk asserts that nvim answers `nvim_eval("1")` within 50 ms during the refresh.
- Status: not started. `init.lua` is 5.5k lines (~190 functions) with a 4.3k-line `init_test`, too large for one pass. Split into sub-stages, each committed green:
  - 4a `session.ts` model: owners/lineage loading, `line_identity`, seen classification (`id_seen`, `hunk_seen`, `progress_counts`, `is_generated`, worktree seen sets via `baseline`/ranges), `compute_combined`, `refresh_model`/`poll` over `Poller`+`GenerationGuard`. Tests: the model-level cases of `init_test`, `dirty_combined_test`, `wt_dup_lines_test`, `reload_test`.
  - 4b `render.ts`: pure `build` → `{lines, highlights, rowMap: RowTarget[]}`, sections, dirtree rows, seen markers with `min_seen_run` demotion and sticky overrides, intraline via `runRefine` + cache. Tests: `marker_test` and render cases of `init_test`.
  - 4c `actions.ts`: reducer for perform/undo/redo, toggle-seen/visual/unmark*, collapse, comments, nav, scope toggle with cursor anchor. Tests: `scope_cursor_test` and action cases of `init_test`.
  - 4d `nvimView.ts` + Lua keymaps dispatching `glean.action`, suspend/resume on BufWinEnter/Leave. Tests: `suspend_test`, keymap round-trip driver test, 50 ms responsiveness driver test.
  - LogView/PrView/jump/diffsplit/sticky float: port in 4d or defer to cutover explicitly.
- 4a progress (partial): `node/session/model.ts` + `model.test.ts`.
  - `buildModel(git, base, Target, {ignoreWhitespace, fromRoot})` runs every git call concurrently (`Promise.all`) and returns `Outcome<ModelData>` (display `files`/`commits` with the WORKTREE layer last, exact `canonicalFiles`/`lineageCommits`/`lineageWorktreeFiles`, resolved `head`). The Lua patch cache (`cached_patches`) is not ported yet.
  - `loadWorktreeSeen` preloads, for uncommitted paths with a stored record only, H via one `showMany` and W from disk, into `WorktreeSeen {unseenAdds, dels}`. This replaces the lazy `wt_versions`/`wt_seen_sets` so classification stays synchronous and IO-free.
  - `Classifier` (pure, rebuilt per model/store change): `commitOwner`/`combinedOwner` return a `LineOwner` union (`commit | worktree | none`) instead of `sha, lnum` nil pairs; `lineIdentity`, `changedIds`, `isGenerated`, `idSeen`, `hunkSeen`, `fileSeen`, `commitSeen`, `progressCounts(scope)`. Lineage is composed eagerly in the constructor (no per-path pending status; combined ownership is always "loaded").
  - Tests: 5 model cases (build ordering, cross-scope identity equality, committed marks + rollups, worktree baseline/del-range classification, untracked + `.gleanignore`).
  - `node/session/session.ts`: `Session` with `refresh()` (generation-guarded; returns `applied | stale | error | timeout`, fresh `Store` + `.gleanignore` per refresh), `reclassify()` (after store writes), `poll({untracked})` (first call records baseline signatures; refreshes only on change) driven by `Poller` via `startLive`/`stop`, and an `onChange` hook for the view. Tests in `session.test.ts` (refresh, stale drop, poll change detection).
  - `Session.applySeen(ids, op)`: committed ids via store ranges; worktree adds move R (`markAdds`/`unmarkAdds`, H via `showMany`, W from disk), worktree dels are head-line range edits; saves touched shards then `reclassify()`. Sticky overrides and the undo stack belong to the 4c reducer. `wtDupLines.test.ts` ports `wt_dup_lines_test` except the legacy (pre-explicit-dels) record case, which the node `Store` doesn't model (legacy worktree data is dropped, see stage 2).
  - `Classifier.dirSeen` takes a scope-tagged file-index list (the commits scope also takes its `ModelCommit`). Deviation: in the combined scope it rolls up `fileSeen` per file rather than Lua's `ids_all_seen` over the target's identities. Lua's "ownership not loaded" case doesn't exist because lineage is eager. Tested in `model.test.ts`.
  - `dirtyCombined.test.ts` ports `dirty_combined_test` at the model level: it drives `Session.applySeen` over file identities instead of row toggles. The header-row toggle case waits for 4c.
  - Commit patch cache: `buildModel` resolves H first, then reuses a `CommitPatchCache` (per whitespace mode, keyed by H, owned by `Session`) so a content-only reload skips the log walk. `reload.test.ts` checks: no `log` on a work-tree edit, exactly one after a commit. Deviation: the composed lineage is still rebuilt per refresh (cheap relative to git), and the poll's `diff HEAD` is not reused by the rebuild.
  - Remaining for 4a: porting the model-level cases of `init_test` and the rest of `reload_test` (the idle/untracked cases need the view; the ignore-whitespace cases need render/jump).
- 4b progress (partial): `node/render/markers.ts` + `markers.test.ts` port `hunk_marker_runs` (`hunkMarkerRuns`, 0-based indices), `display_seen_map` (`displaySeenSet`) and `marker_key`/`cmarker_key` (one `markerKey(scope, …)` returning a branded `MarkerKey`); all `marker_test` cases pass. Deviation: only add lines contribute marker lnum bounds, because node dels carry a `newLnum` slot that Lua's test fixtures lacked.
  - `node/render/render.ts`: pure `render(RenderInput) -> Frame {lines, rows: RowTarget[], highlights, sections, intraBlocks}`. Ports `Session:build` minus comments (comment rows and the summary section wait for 4c) and minus the `pending` loading state (lineage is eager). `RowTarget` is a union (`mode-header | commit-header | dir | file-header | seen-section | divider | hunk-header | line | marker | marker-line | blank`) with a `FileRef` scope-tagged file address; `li` is 0-based. Collapse state is a `Map<CollapseKey, boolean>` of explicit overrides (branded keys built by `keys.*`, same strings as Lua); defaults are computed at render (commit/file/dir: seen; combined file: expanded; seen section and markers: collapsed), replacing Lua's mutable `collapsed` fields and `apply_collapse`. Intra-line refinement is not applied in `render`; `intraBlocks` are handed to `runRefine` by the view (4d). Tests in `render.test.ts` (3 cases). Remaining for 4b: port the render cases of `init_test`, and the refine cache.
- 4c progress (partial): hunk-header/line rows now carry `sec: "seen" | "unseen"`. `node/render/actions.ts` holds pure planners: `targetIds` (the identities a row addresses), `planToggleSeen` (returns `SeenPlan {op, ids, sticky, clear}`; the section decides the op, headers fall back to all-seen; marker rows unmark their run's seen lines; `clear` lists the seen/dir overrides to drop so marked content re-collapses), `collapseTarget`/`toggleCollapse` (flip the effective state against the render default), and `hunkKey`/`nextUnseenHunk`/`rowOfHunk` for cursor landing. Tests in `actions.test.ts`. Undo/redo: `Session` owns `collapse` (ephemeral overrides) and an `Undoable` (`seen | collapse`) undo/redo stack; `perform`/`undo`/`redo` apply a `SeenPlan` via `applySeen(ids, op, sticky)` (sticky add/remove saved in the WORKTREE shard even when the seen write is a no-op). `plan.clear` is applied on perform only, not reversed on undo. Tested in `session.test.ts`. Scope-toggle cursor anchor: `node/render/anchor.ts` (`cursorAnchor`, `restoreAnchor` → row; exact identity, then same owner's nearest, then nearest display line, then file header), tested in `anchor.test.ts` (identity round trip across scopes, header case). The collapsed-destination expansion case of `scope_cursor_test` waits for the view (4d: expand the path, re-render, then restore). Remaining for 4c: revive-destination on unmark, visual range, comments (+ rendering), and the header-toggle case of `dirty_combined_test`.

## Gutter and file-buffer marking

- Goal: `gutter.ts` projects into file buffers from BufEnter/TextChanged events, fetching buffer text via `nvim_buf_get_lines`. The gitsigns detach/reattach stays in Lua as a small helper that node calls. `:Glean toggle-mark` and the `gmc` hunk highlight are ported. `bufundo` is ported too.
- Tests: port `gutter_test` and `toggle_mark_test`. A driver test edits a file buffer and sees signs update.

## Agent API

- Goal: `api.lua` becomes an rpcrequest shim, `api.ts` serves from memory, and `skills/glean-review/skill.md` is updated.
- Tests: port `api_test`. Call the api while a refresh is running and assert it returns promptly.

## Cutover

- Goal: delete the Lua implementation modules, `run_tests.lua` and `testutil.lua`. Update `README.md` and `context.md` (architecture, layout, commands: `npx tsc`, `npx vitest run`, `npx biome check .`, `npm run build`). `dist/` is built and bundled the way magenta does it.
- Tests: the full suite, and a manual review in `dlants-monolith-temporal-eks` and `dlants-ddt-simplification`, the two repos that caused the hangs.
