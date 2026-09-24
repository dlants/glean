# glean — developer guide

glean is a git diff reviewer rendered into a single foldable, navigable neovim
buffer. The model (file/commit diff data overlaid with a persisted review store)
is the single source of truth; the buffer is a pure read-only projection of it,
and every interaction is an action that mutates the store and re-renders. See
`README.md` for the user-facing feature set and keymaps.

## Architecture

glean is split like magenta: a thin Lua layer and one node process per nvim.
Lua only starts node, bridges its channel back (`:Glean`, autocmds, keymaps)
and forwards each event as one `rpcnotify` (or `rpcrequest` for the agent
api). Node owns the model, store, git (async, every call with a timeout),
diffing and rendering, and writes to nvim in bounded batches. Superlinear pure
work is capped and yields between blocks; stale async results are dropped by
generation. See `.github/instructions/` for the review rules that enforce this,
including branded/union types over nullable fields.

The core invariant: the **model is the source of truth, the buffer is a pure
projection**. A parallel `row_map[row]` resolves any cursor row back to its
commit/file/hunk/line so actions act on the semantic target rather than buffer
text. Seen-ness has a single representation — a flat set of stable, serializable
line-identities — so "renders in the seen section" and "the action layer thinks
it is seen" are one computation by construction. Collapse state is ephemeral
view-state, initialized from seen status then evolved independently (never
persisted).

In the combined scope, within-hunk marker rendering applies a display-only
demotion (config `min_seen_run`, default 5): a seen run shorter than the
threshold inside a partially-seen hunk renders as plain unseen rows rather than a
collapsed `✓ marked` marker. This never touches the persisted `(sha, lnum)` seen
model or section/rollup counts — it is purely how a partially-seen hunk looks
inside. Explicit re-marks record a content-addressed sticky override (keyed by
path + `state.line_hash(text)`, persisted in the always-loaded `WORKTREE` shard
alongside comments) that exempts a line from demotion across renders/reopens and
self-invalidates when the line's content changes.

A live session always tracks the work tree: the poll timer and the model
refresh follow the *session*, not its window, because the gutter and the
file-buffer marking path read the model with the review nowhere on screen.
Visibility only gates the view work — pending streaming repaints and the sticky
float — which a hidden buffer drops and re-attaches (with one immediate poll)
when it is displayed again.

Because both scopes derive a line's identity from its owning commit (commit
scope directly, combined scope via composed blame provenance), the same physical
line has the same identity in both. Toggling scope preserves the cursor by
looking that identity up in the new projection, degrading to the same commit's
nearest line, then the nearest line by number in the file, then the file header.

Line identities come in three kinds:
- committed add line → `(sha, post-image lnum)`
- committed del line → `(remover_sha, pre-image lnum)`
- uncommitted worktree line → `(path, lnum)`, where `lnum` is the work-tree line
  for an added line and the tip-commit line for a deleted one

The first two are stable because both endpoints of a committed pair are
immutable. The third is not, and the two halves of an uncommitted diff are
therefore stored differently, by the stability of the coordinate each is named
in. With H the file at the review's tip commit and W the work tree:

- A **deleted** line is named by its H line number. H is immutable while the
  record lives (the record is anchored by a hash of H's content, and a moved tip
  drops it wholesale), so approved deletions are stored *explicitly* as
  inclusive ranges of head line numbers. No diff is consulted: marking is a
  range insert, unmarking a range remove, classification a `covers` test. A
  repeated line's seen-ness therefore cannot depend on a diff picking the
  "right" copy of it.
- An **added** line is named by its work-tree line number, which shifts under
  editing, so its seen-ness is derived from a **reviewed baseline** R — the
  content the reviewer signed off on, persisted per path in the `WORKTREE`
  shard. An added line is seen iff it is not an added line of `diff(R, W)`.
  Marking advances R toward W over the selected lines; unmarking retreats it
  toward H. R is never shrunk below H, so `diff(H, R)` is add-only: R is exactly
  "H plus the approved additions". Editing a marked line makes exactly that line
  unseen and leaves its neighbours seen.

A moved H (a commit) drops the anchor-mismatched record — dels included — for
exactly the paths whose content changed. `node/core/baseline.ts` holds the pure adds-only
algebra; `plans/2026-08-28-reviewed-baseline.md` holds the original reasoning and
`plans/2026-08-29-explicit-del-seen.md` the split.

## Layout

- `lua/glean/` — the thin side.
  - `init.lua`: `setup` (config into `vim.g.glean_*`, highlights, starts node).
  - `node.lua`: `start` (bundle `dist/glean.mjs`, or source with `GLEAN_DEV=1`), `bridge`/`teardown_bridge`, `safe_rpcnotify`, `:Glean`, and the review buffer keymaps.
  - `node_gutter.lua`: file-buffer autocmds/maps, buffer info queries, gitsigns detach/attach.
  - `api.lua`: the agent api shim (one `rpcrequest` per call), documented by `skills/glean-review/skill.md`.
  - `node_overlay.lua`: file-buffer comment overlay autocmds, `<Plug>(glean-comment*)` maps, float helper.
- `node/` — the backend.
  - `index.ts`/`glean.ts`: attach, RPC registration and command/action/gutter/api dispatch, `nvimAppUi` adapter.
  - `app.ts`: nvim-free `App` core behind `AppUi` — review registry (one review at a time, default review for `:Glean jump`), log/PR list state and paging, store location (`<data>/glean/<sha256(git common dir)[:16]>`, worktree shard `WORKTREE/<branch>`).
  - `targets.ts`: review targets (dirty/branch/PR/range resolution, titles), LogView and PrView rendering/paging, the injectable `gh` runner.
  - `core/`: pure modules — `diff`, `linediff` (Myers), `intraline` (capped), `baseline`, `lineage`, `ranges`, `state` (sharded JSON store), `ignore`, `comments`, `dirtree`, `types` (brands, `LineId`).
  - `git/`: `git.ts` (injectable `GitRunner`, `Outcome` results, `Poller`), `scheduler.ts` (`GenerationGuard`, `runRefine`, `RefineCache`).
  - `session/`: `model.ts` (`buildModel`, `Classifier`), `session.ts` (refresh/poll, seen writes, undo/redo, collapse).
  - `render/`: pure `render` → `Frame` with a `RowTarget` per row, markers, actions planners, scope anchor, comment placement, `nav` (hunk/file nav, jump/diffsplit targets), `sticky` (float ancestry), `commentActions` (comment editor targets).
  - `view/`: `review.ts` (nvim-free `ReviewController` behind `ReviewUi`: action dispatch, planners + `Session`, cursor, comments, jump resolution); `view.ts` (`ReviewView`, the nvim adapter: row-diffed batched painting, intraline, active-hunk decor, sticky float, suspend/resume); `jump.ts` (`resolveJump` + window ops), `prompts.ts` (promise-based editor/picker by token).
  - `overlay/`: file-buffer comment overlay (pure `project.ts`, `overlay.ts` core behind `OverlayUi`, `nvimOverlayUi.ts` adapter, `:Glean comment(s)`).
  - `gutter/`: pure projection and marking, `FileGutter` core behind `GutterUi`, `nvimGutterUi.ts` adapter, per-buffer mark undo.
  - `api/api.ts`: the agent api, served from memory with a pending fallback.
  - `nvim/`: RPC client copied from magenta; `test/`: embedded-nvim driver, fixture repos, and `ui.ts` port recorders for node-only controller tests (see `.magenta/skills/testing/skill.md`).

## Commands

- `npx tsc -p .` — typecheck
- `npx vitest run` — all tests (unit tests colocated as `*.test.ts`, driver tests as `*.driver.test.ts` against a real headless nvim)
- `npx biome check .` — lint/format
- `npm run build` (or `npm run bundle` without `npm ci`) — builds `dist/glean.mjs`, which is gitignored and built on install like magenta

## Semantic search (pkb)

`./pkb search "<query>"` searches a semantic index of this repo (checked in under `.pkb/index`, config in `.pkb/config.toml`, `plans/` excluded). Prefer it over grep for orientation questions; see `.magenta/skills/pkb-search/skill.md`. `hooks/pre-commit` runs typecheck + biome (`hooks/checks.mjs`) and reindexes staged content into each commit; enable it with `git config core.hooksPath hooks`.
