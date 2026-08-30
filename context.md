# glean — developer guide

glean is a git diff reviewer rendered into a single foldable, navigable neovim
buffer. The model (file/commit diff data overlaid with a persisted review store)
is the single source of truth; the buffer is a pure read-only projection of it,
and every interaction is an action that mutates the store and re-renders. See
`README.md` for the user-facing feature set and keymaps.

## Architecture

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
exactly the paths whose content changed. `baseline.lua` holds the pure adds-only
algebra; `plans/2026-08-28-reviewed-baseline.md` holds the original reasoning and
`plans/2026-08-29-explicit-del-seen.md` the split.

## Layout (`lua/glean/`)

- `init.lua` — the bulk of the plugin (~2.5k lines): `setup`, the `:Glean`
  command, model build, renderer, `row_map`, keymaps/actions, live work-tree
  polling, and the two scopes (combined / commits). Start here.
- `git.lua` — the git handle. All git calls go through `Git:run`; the runner is
  injectable (`opts.run`) so tests never shell out. Produces FileEntries/Commits.
- `diff.lua` — pure unified-diff parser (no git, no IO). Turns `git diff` text
  into ordered FileEntries / Hunks / DiffLines, each carrying `new_lnum`.
- `api.lua` — the flat, JSON-only programmatic surface (session/comment listing,
  agent replies, and paged hunk query / seen-marking) that magenta drives over
  `nvim_exec_lua`; documented for agents by
  `skills/glean-review/skill.md`, which dotfiles symlinks into `~/.claude/skills`.- `state.lua` — the persisted ReviewStore. Keyed by commit sha, sharded one JSON
  file per commit on disk (`<dir>/<sha>.json`), merged in memory. Holds seen
  ranges, del ranges, and — in the `WORKTREE` shard — content-addressed comments
  and the per-path uncommitted records (`{ head, lines, dels }`: the reviewed
  baseline for approved additions, explicit head-line ranges for approved
  deletions).
- `gutter.lua` — projects the live work-tree review into the sign column of
  ordinary file buffers (add/change/delete glyphs coloured by seen status), and
  detaches/reattaches the foreign sign provider (gitsigns) for those buffers.
  `M.project` is pure and headless-tested.
  Each projected row also retains the `{hunk, li}` coordinates of the diff lines
  folded into it, which is the inverse the file-buffer marking path
  (`:Glean toggle-mark` → `M.toggle_mark` → `Session:toggle_marks`) rides back
  into `diff(B, W)` before resolving identities and calling the usual
  `Session:perform{kind = "seen"}`. The map is many-to-one, so one row can carry
  its paired del and any attached deletions.
- `ignore.lua` — pure `.gleanignore` matcher (gitignore syntax compiled to vim
  regex). A matching path is *derived*-seen via `Session:is_generated` short-
  circuiting `id_seen`, so generated files collapse and leave the unreviewed
  counts without any store write to unwind when a pattern goes away.
- `baseline.lua` — pure reviewed-baseline algebra for *additions only*
  (alignment via `vim.diff`, `seen_adds` classification, `mark_adds`/
  `unmark_adds` as edits to R). Deletions are not its business. No git, no store.
- `provenance.lua` — pure `git blame -p` porcelain parser for per-line ownership
  in the combined view; git invocation injected by the caller.
- `intraline.lua` — pure word-level intra-line diff highlighting helpers
  (tokenizer + alignment), no nvim API so it is headless-testable.
- `testutil.lua` — tiny dependency-free assert harness shared by all test suites.
- `run_tests.lua` — runs every `*_test.lua` in one shot.

## Tests

Each module has a colocated `*_test.lua` run headless via `nvim -l`. Run the
whole suite from the repo root:

```sh
nvim -l lua/glean/run_tests.lua
```

It exits nonzero if any suite fails. Run one suite directly with
`nvim -l lua/glean/<name>_test.lua`. The pure modules (`diff`, `state`,
`provenance`, `intraline`) test directly; `git`-dependent code injects a fake
runner.
