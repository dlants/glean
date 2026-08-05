# glean

A git diff reviewer that renders the diff between two refs in a single
foldable, navigable neovim buffer. The buffer is a read-only projection of a
review model; all interaction happens through actions that mutate a persistent
review store, so seen-marks and comments survive across sessions.

## Opening

```vim
:Glean                  " review current branch + dirty work tree
:Glean log              " browse commits, then open one or a selected range
:Glean prs              " browse currently open GitHub pull requests
:Glean <base>           " review <base> + dirty work tree
:Glean <base> <target>  " review <base>..<target> (no dirty work tree)
:Glean <pr-number>      " fetch and review a GitHub pull request
:Glean <pr-url>         " likewise, using https://github.com/.../pull/...
```

GitHub pull requests are resolved with the `gh` CLI. Their head and base commits
are fetched into the local object store without changing the checkout, and
content-addressed review data is stored under the pull request's head branch.
The existing `:Glean pr [number]` form remains available.

`:Glean` with no args opens the "dirty" review: on a feature
branch the base is the fork point (merge-base) from the default trunk, so you
see the branch's own commits plus uncommitted edits; on the trunk itself the
base is the upstream tracking ref, so you see unpushed commits plus uncommitted
edits.

A live work-tree review refreshes on save and on regaining focus (with a 5s
safety-net poll for changes made outside the editor) and re-renders in place as

files change, preserving the cursor and your collapse state.

Reopening the same `base..target` reuses the existing listed buffer rather than
spawning a duplicate, so you can jump to a source file and return via the buffer
list / `<C-^>`.

`:Glean log` opens the current repository's first-parent history, newest first.
Press `<CR>` on a commit to review it, or visually select a contiguous set of
commits and press `<CR>` to review that range. The log and resulting reviews use
the same persistent listed-buffer and window-reuse behavior as other Glean views.

`:Glean prs` uses `gh pr list` to show currently open pull requests. Press `<CR>`
to review the PR under the cursor. Use `]p` and `[p` to move between pages; PR
selection is intentionally single-row only, with no visual-mode action.

## Two scopes

Toggle with `S`:

- **combined** (default) — the net `base..target` diff. Per-line ownership is
  derived by composing the first-parent patches in the range: additions are
  credited to the commit that introduced them, deletions to the commit that
  removed them.
- **commits** — every commit laid out flat. Seen-marks and comments are authored
  against a stable `(commit_sha, path, line)` identity here, and the same mark
  is reflected in the combined view.

## Ignore whitespace mode

Press `W` to toggle ignore-whitespace mode for the current review. While enabled,
the scope label in the header includes `ignore-whitespace`, and progress counts
cover only the changes still visible in that mode. The setting is view state for
the review session: it does not create a separate review store, and toggling back
restores whitespace-only rows together with their existing seen marks and
comments.

This mode uses Git's `--ignore-all-space` when producing the displayed diff:
whitespace is ignored while comparing lines. glean does not trim or normalize
the text it renders, so visible lines retain their exact content and source line
numbers. In particular, this is Git's behavior rather than a rule that removes
every blank line; a newly added blank line may still be a real addition.
Untracked files have no pre-image to compare and therefore render identically in
both modes.

## Seen / collapse

Seen-ness is a flat set of stable line identities. A hunk is "seen" iff every
one of its changed lines is seen; files and commits roll up the same way. Seen
units render in a collapsible per-file "seen" section, and a contiguous seen run
inside an otherwise-unseen hunk collapses into a `✓ marked N lines` marker row.

The top row reports the remaining unreviewed files, hunks, additions, and
deletions. It stays pinned in the floating header while scrolling.

Collapse state is ephemeral view-state (initialized from seen status, then
evolves independently and is never persisted).

Files are grouped under a row per directory component; a directory row rolls up
the files beneath it, so `=` folds the whole subtree away and `m` marks every
file under it seen (or unmarks them all when the directory is already fully
seen). Directories with a single changed child collapse into one row, so a lone
chain renders as `a/b/c/` (or, if it holds a single file, as `a/b/c/file`).

A collapsed row (file or directory) reports what it hides as `(n seen / m
unseen)`, counted in hunks; a hunk with only some of its lines marked counts as
unseen.

## Comments

Comments are content-addressed records attached per path and re-anchored to
their matching diff line on every render, so they follow the code as the diff
changes. A comment whose anchor disappears is flagged outdated and shown in the
file summary. If its anchor is merely a whitespace-only row hidden by
ignore-whitespace mode, the summary instead labels it `Hidden by whitespace
mode`. Pressing `<CR>` on that summary entry disables the mode, reveals the
original row, and jumps to the inline comment.

The comment editor opens in a markdown split. Submit with `<CR>` (normal mode)
or by writing the buffer (`:w`); abort with `q` or `<C-c>`. Submitting an
empty/whitespace-only buffer is treated as an abort.

Every comment is also listed in a summary section at the bottom of the buffer.
The summary rows are live: `i`/`dd` edit or delete the comment from there,
visual `d` deletes all selected comments as one undoable action, and
`<CR>` navigates back into the diff — on a comment row it expands that hunk and
parks the cursor on the comment above; on a file row it jumps to that file's
header.

## Keymaps (inside the glean buffer)

- `m` (normal) — toggle seen on the hunk/file/directory/commit under the cursor; on a marker row/line, unmark that run
- `m` (visual) — mark the selected lines seen
- `ac` (visual / operator) — text object selecting the hunk under the cursor (e.g. `vac`)
- `=` — toggle collapse (section, file, directory, commit, or marker row)
- `c` (normal) — comment on the current line
- `c` (visual) — comment on the selected span
- `i` — edit the comment under the cursor
- `dd` — delete the comment under the cursor
- `d` (visual) — delete all selected comments in the comment summary
- `dc` — delete a comment attached to the current line
- `u` / `<C-r>` — undo / redo (seen, comment, collapse actions)
- `]c` / `[c` — next / previous hunk
- `]f` / `[f` — next / previous file
- `<CR>` — jump to the source line (live file when the ref is HEAD, else a read-only `git show` buffer); on a comment-summary row, navigate to the comment/file in the diff instead
- `D` — open an ephemeral side-by-side diff for the hunk under the cursor
- `S` — toggle scope (combined / commits)
- `W` — toggle ignore-whitespace mode (Git `--ignore-all-space`)
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
  ignore_whitespace = false,  -- start reviews with Git --ignore-all-space display mode
  min_seen_run = 5,        -- combined-scope: demote seen runs shorter than this to unseen
  hunk_indent = 2,         -- display indent for the active hunk body
  hunk_indent_delay_ms = 50,  -- wait before applying the active-hunk indent
})
```

`setup` registers the `:Glean` command and defines the
highlight groups (re-derived from `DiffAdd`/`DiffDelete` on every `ColorScheme`).

`ignore_whitespace` selects the initial display mode for newly opened reviews;
`W` can change it in place at any time. The mode affects rendered files, hunks,
changed lines, and progress counts, but source buffers and persisted review data
remain exact.

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

### Removed: `max_blame_jobs`

Combined-scope ownership no longer runs `git blame` per file — it is composed
from a single `git log -p` walk of the range — so the `max_blame_jobs` option is
gone. Passing it to `setup` has no effect.

## Related plugins

Other neovim plugins by [dlants](https://github.com/dlants):

- [magenta.nvim](https://github.com/dlants/magenta.nvim) — transparent tools for agentic AI workflows.
- [needle](https://github.com/dlants/needle) — a fast, signal-aware fuzzy picker.
- [shuck](https://github.com/dlants/shuck) — a streamed shell-command picker (live-grep replacement).
