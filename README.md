# glean

A git diff reviewer that renders the diff between two refs in a single
foldable, navigable neovim buffer. The buffer is a read-only projection of a
review model; all interaction happens through actions that mutate a persistent
review store, so seen-marks and comments survive across sessions.

## Opening

```vim
:Glean                  " review current branch + dirty work tree
:Glean <base>           " review <base> + dirty work tree
:Glean <base> <target>  " review <base>..<target> (no dirty work tree)
```

`:Glean` with no args opens the "dirty" review: on a feature
branch the base is the fork point (merge-base) from the default trunk, so you
see the branch's own commits plus uncommitted edits; on the trunk itself the
base is the upstream tracking ref, so you see unpushed commits plus uncommitted
edits.

A live work-tree review polls the repo (every 1.5s) and re-renders in place as
files change, preserving the cursor and your collapse state.

Reopening the same `base..target` reuses the existing listed buffer rather than
spawning a duplicate, so you can jump to a source file and return via the buffer
list / `<C-^>`.

## Two scopes

Toggle with `S`:

- **combined** (default) — the net `base..target` diff. Deletions are attributed
  to the commit that removed them via reverse blame; additions to their blame
  provenance.
- **commits** — every commit laid out flat. Seen-marks and comments are authored
  against a stable `(commit_sha, path, line)` identity here, and the same mark
  is reflected in the combined view.

## Seen / collapse

Seen-ness is a flat set of stable line identities. A hunk is "seen" iff every
one of its changed lines is seen; files and commits roll up the same way. Seen
units render in a collapsible per-file "seen" section, and a contiguous seen run
inside an otherwise-unseen hunk collapses into a `✓ marked N lines` marker row.

Collapse state is ephemeral view-state (initialized from seen status, then
evolves independently and is never persisted).

## Comments

Comments are content-addressed records attached per path and re-anchored to
their matching diff line on every render, so they follow the code as the diff
changes. A comment whose anchor disappears is flagged outdated and shown in the
file summary.

The comment editor opens in a markdown split. Submit with `<CR>` (normal mode)
or by writing the buffer (`:w`); abort with `q` or `<C-c>`. Submitting an
empty/whitespace-only buffer is treated as an abort.

Every comment is also listed in a summary section at the bottom of the buffer.
The summary rows are live: `i`/`dd` edit or delete the comment from there, and
`<CR>` navigates back into the diff — on a comment row it expands that hunk and
parks the cursor on the comment above; on a file row it jumps to that file's
header.

## Keymaps (inside the glean buffer)

- `m` (normal) — toggle seen on the hunk/file/commit under the cursor; on a marker row/line, unmark that run
- `m` (visual) — mark the selected lines seen
- `ac` (visual / operator) — text object selecting the hunk under the cursor (e.g. `vac`)
- `=` — toggle collapse (section, file, commit, or marker row)
- `c` (normal) — comment on the current line
- `c` (visual) — comment on the selected span
- `i` — edit the comment under the cursor
- `dd` — delete the comment under the cursor
- `dc` — delete a comment attached to the current line
- `u` / `<C-r>` — undo / redo (seen, comment, collapse actions)
- `]c` / `[c` — next / previous hunk
- `]f` / `[f` — next / previous file
- `<CR>` — jump to the source line (live file when the ref is HEAD, else a read-only `git show` buffer); on a comment-summary row, navigate to the comment/file in the diff instead
- `D` — open an ephemeral side-by-side diff for the hunk under the cursor
- `S` — toggle scope (combined / commits)
- `q` — close the window

## Installation

Install with Neovim's native plugin manager (`vim.pack`, Neovim 0.12+):

```lua
vim.pack.add({ "https://github.com/dlants/glean" })
require("glean").setup({ default_base = "main" })
```

glean has no external plugin dependencies — it shells out to `git`. Neovim
0.12+ is required.

## Setup

```lua
require("glean.init").setup({
  default_base = "main",   -- trunk used for fork-point / upstream resolution
  min_seen_run = 5,        -- combined-scope: demote seen runs shorter than this to unseen
  max_blame_jobs = 4,      -- max concurrent `git blame` jobs (default: half the CPU count)
})
```

`setup` registers the `:Glean` command and defines the
highlight groups (re-derived from `DiffAdd`/`DiffDelete` on every `ColorScheme`).

### `min_seen_run`

When you revisit code you previously reviewed and an agent has since changed it,
a single combined-scope hunk can end up with short, scattered runs of
previously-seen lines interleaved with newer unseen changes. `min_seen_run` is a
display-only threshold (default `5`): in the combined scope, a seen run shorter
than `min_seen_run` lines inside an otherwise-unseen hunk is rendered as ordinary
unseen `+`/`-` rows instead of a collapsed `✓ marked N lines` marker, so you no
longer have to unmark scattered lines by hand. Longer seen runs still collapse to
a marker. Set `min_seen_run` to `1` (or `0`) to disable demotion.

The persisted seen store is never touched by this — it stays the plain
`(commit, line)` model. If you explicitly re-mark a demoted line as seen in the
current context, that mark is recorded as a content-addressed sticky override
that keeps the line seen across renders and reopens, and self-invalidates once
the line's content changes again.

### `max_blame_jobs`

In the combined scope, per-line commit ownership is resolved with `git blame`,
one invocation per displayed file, run in the background so the buffer paints
immediately and seen placement streams in as each file settles. `max_blame_jobs`
caps how many of those blame subprocesses run concurrently (default: half the
logical CPU count, at least 1). Raise it to load large reviews faster at the cost
of more parallel git processes; set it to `1` for the old fully-serial behavior.

## Related plugins

Other neovim plugins by [dlants](https://github.com/dlants):

- [magenta.nvim](https://github.com/dlants/magenta.nvim) — transparent tools for agentic AI workflows.
- [needle](https://github.com/dlants/needle) — a fast, signal-aware fuzzy picker.
- [shuck](https://github.com/dlants/shuck) — a streamed shell-command picker (live-grep replacement).
