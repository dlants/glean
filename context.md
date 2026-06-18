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

Line identities come in three kinds:
- committed add line → `(sha, post-image lnum)`
- committed del line → `(remover_sha, pre-image lnum)`
- uncommitted worktree line → content hash of the line text

## Layout (`lua/glean/`)

- `init.lua` — the bulk of the plugin (~2.5k lines): `setup`, the `:Glean`
  command, model build, renderer, `row_map`, keymaps/actions, live work-tree
  polling, and the two scopes (combined / commits). Start here.
- `git.lua` — the git handle. All git calls go through `Git:run`; the runner is
  injectable (`opts.run`) so tests never shell out. Produces FileEntries/Commits.
- `diff.lua` — pure unified-diff parser (no git, no IO). Turns `git diff` text
  into ordered FileEntries / Hunks / DiffLines, each carrying `new_lnum`.
- `state.lua` — the persisted ReviewStore. Keyed by commit sha, sharded one JSON
  file per commit on disk (`<dir>/<sha>.json`), merged in memory. Holds seen
  ranges, del ranges, and content-addressed comments (in the `WORKTREE` shard).
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
