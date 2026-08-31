# glean

A git diff reviewer that renders the diff between two refs in a single foldable, navigable neovim buffer. The buffer is a read-only projection of a review model; all interaction happens through actions that mutate a persistent review store, so seen-marks and comments survive across sessions.

## Opening

```vim
:Glean                  " review current branch + dirty work tree
:Glean log              " browse commits, then open one or a selected range
:Glean jump             " from a file buffer, jump to that file+line in the review
:Glean toggle-mark      " from a file buffer, mark/unmark the hunk or selection seen
:Glean toggle-gutter    " turn the sign-column projection on/off everywhere
:Glean prs              " browse currently open GitHub pull requests
:Glean <base>           " review <base> + dirty work tree
:Glean <base> <target>  " review <base>..<target> (no dirty work tree)
:Glean <pr-number>      " fetch and review a GitHub pull request
:Glean <pr-url>         " likewise, using https://github.com/.../pull/...
```

GitHub pull requests are resolved with the `gh` CLI. Their head and base commits are fetched into the local object store without changing the checkout, and content-addressed review data is stored under the pull request's head branch. The existing `:Glean pr [number]` form remains available.

`:Glean` with no args opens the "dirty" review: on a feature branch the base is the fork point (merge-base) from the default trunk, so you see the branch's own commits plus uncommitted edits; on the trunk itself the base is the upstream tracking ref, so you see unpushed commits plus uncommitted edits.

A live work-tree review refreshes on save and on regaining focus (with a 5s safety-net poll for changes made outside the editor) and re-renders in place as

files change, preserving the cursor and your collapse state.

`:Glean jump` is the inverse of `<CR>` in the review: run it in a source file and the cursor moves into the review at that file and line, expanding the file, its seen section, and any collapsed seen runs hiding the line. With no review open it opens the default (`:Glean`) one first.

Reopening the same `base..target` reuses the existing listed buffer rather than spawning a duplicate, so you can jump to a source file and return via the buffer list / `<C-^>`.

`:Glean log` opens the current repository's first-parent history, newest first. Its first row is the dirty work tree. Press `<CR>` on a row to review it, or visually select a contiguous set of rows and press `<CR>` to review that range; including the dirty row makes the work tree the review target. Only the most recent 200 commits are loaded up front; press `]p` to append the next page of older history. The log and resulting reviews use the same persistent listed-buffer and window-reuse behavior as other Glean views.

`:Glean prs` uses `gh pr list` to show currently open pull requests. Press `<CR>` to review the PR under the cursor. Use `]p` and `[p` to move between pages; PR selection is intentionally single-row only, with no visual-mode action.

## Two scopes

Toggle with `S`:

- **combined** (default) — the net `base..target` diff. Per-line ownership is derived by composing the first-parent patches in the range: additions are credited to the commit that introduced them, deletions to the commit that removed them.
- **commits** — every commit laid out flat. Seen-marks and comments are authored against a stable `(commit_sha, path, line)` identity here, and the same mark is reflected in the combined view.

## Ignore whitespace mode

Press `W` to toggle ignore-whitespace mode for the current review. While enabled, the scope label in the header includes `ignore-whitespace`, and progress counts cover only the changes still visible in that mode. The setting is view state for the review session: it does not create a separate review store, and toggling back restores whitespace-only rows together with their existing seen marks and comments.

This mode uses Git's `--ignore-all-space` when producing the displayed diff: whitespace is ignored while comparing lines. glean does not trim or normalize the text it renders, so visible lines retain their exact content and source line numbers. In particular, this is Git's behavior rather than a rule that removes every blank line; a newly added blank line may still be a real addition. Untracked files have no pre-image to compare and therefore render identically in both modes.

## Seen / collapse

Seen-ness is a flat set of line identities. A hunk is "seen" iff every one of its changed lines is seen; files and commits roll up the same way. Seen units render in a collapsible per-file "seen" section, and a contiguous seen run inside an otherwise-unseen hunk collapses into a `✓ marked N lines` marker row.

The top row reports the remaining unreviewed files, hunks, additions, and deletions. It stays pinned in the floating header while scrolling.

For committed changes a mark is just a line number on a commit, and both sides of the comparison are immutable. For _uncommitted_ work "seen" means you signed off on a particular version of the line: glean remembers the content you approved and compares it against the file as it is now, so the parts you subsequently change come back as unseen while everything you did not touch stays marked. Committing resets the seen state for the files the commit touched — the changes you approved are no longer the changes on screen.

Collapse state is ephemeral view-state (initialized from seen status, then evolves independently and is never persisted).

Files are grouped under a row per directory component; a directory row rolls up the files beneath it, so `=` folds the whole subtree away and `m` marks every file under it seen (or unmarks them all when the directory is already fully seen). Directories with a single changed child collapse into one row, so a lone chain renders as `a/b/c/` (or, if it holds a single file, as `a/b/c/file`).

A collapsed row (file or directory) reports what it hides as `(n seen / m unseen)`, counted in hunks; a hunk with only some of its lines marked counts as unseen.

### Generated files (`.gleanignore`)

A repo can declare its generated files in a `.gleanignore` at its root, using gitignore syntax (negation, `**`, anchoring and directory patterns all behave as they do in `.gitignore`). Matching files are treated as already seen, so they render collapsed in the seen section and drop out of the unreviewed counts. This is derived, not recorded: nothing is written to the review store, so removing a pattern brings the file back as unreviewed. The file is re-read on every reload.

## Comments

Comments are content-addressed records attached per path and re-anchored to their matching diff line on every render, so they follow the code as the diff changes. A comment whose anchor disappears is flagged outdated and shown in the file summary as `(outdated)`. If its anchor is merely a whitespace-only row hidden by ignore-whitespace mode, the summary instead labels it `(hidden)`. Pressing `<CR>` on that summary entry disables the mode, reveals the original row, and jumps to the inline comment.

The comment editor opens in a markdown split. Submit with `<CR>` (normal mode) or by writing the buffer (`:w`); abort with `q` or `<C-c>`. Submitting an empty/whitespace-only buffer is treated as an abort.

Every comment is also listed in a summary section at the bottom of the buffer. Each entry is one header row — `[id] L<lnum>` plus a truncated preview of the anchored line — followed by the comment text under `💬` and the agent reply under `↳`. The summary rows are live: `i`/`dd` edit or delete the comment from there, visual `d` deletes all selected comments as one undoable action, and `<CR>` navigates back into the diff — on a comment row it expands that hunk and parks the cursor on the comment above; on a file row it jumps to that file's header.

### Comments in ordinary files

Comments are not tied to the review buffer. Opening any file in the repo shows its comments as a `💬` sign on the resolved line, with the comment's first line as dimmed end-of-line text; `require("glean.overlay").show()` floats the full body and any agent reply, and `require("glean.overlay").toggle()` switches between signs only and inline bodies. Positions are never tracked — every comment is re-resolved by content whenever the buffer is read, written or reloaded from disk (so an agent rewriting the file works exactly like your own edits), and a comment that moved has its new line persisted. A file with no comments is left completely untouched.

`:Glean comments` dumps every comment in the repo into the quickfix list, resolved against the working tree, with unresolvable ones marked `(outdated)`.

You can also leave comments from any file. `:Glean comment` comments on the cursor line and `:'<,'>Glean comment` on a range, both opening the same ephemeral editor the review buffer uses. Because a file buffer is your editing surface, glean claims no key in it by default and ships `<Plug>` mappings instead:

- `<Plug>(glean-comment)` — comment on the line (normal) or the selection (visual)
- `<Plug>(glean-comment-show)` — float the cursor line's comments
- `<Plug>(glean-comment-edit)` / `<Plug>(glean-comment-delete)` / `<Plug>(glean-comment-reply)`
- `<Plug>(glean-comment-next)` / `<Plug>(glean-comment-prev)` — jump by resolved position
- `<Plug>(glean-comment-toggle)` — inline bodies versus signs only

Setting `overlay = { overlay_keymaps = "<leader>c" }` wires the defaults under a prefix (`c`, `s`, `e`, `d`, `r`, `n`, `p`, `t`).

In a buffer that carries comments, or one where you have marked lines from the gutter, `u` and `<C-r>` undo and redo glean's actions first and fall through to the buffer's own undo once there are none — the same rule the review buffer follows.
A comment or a mark changes no text, so it never enters the buffer's undo tree; undo and redo park the cursor on the row the action touched, and a novel edit wipes the glean stack.

### Review status in ordinary files

While a work-tree review is open, every file it touches carries the review's own sign column: `▎` on added and changed lines and `▁` where lines were removed, coloured by seen status — unseen lines link to `DiffAdd`/`DiffChange`/ `DiffDelete`, marked lines grey out to `Comment`, so what still needs review is what draws the eye. Unchanged lines *between* two changes of the same hunk carry a thinner, dimmer `▏`, so a hunk reads as one region rather than a scatter of rows; that marker is decoration only — `]c` never stops on it and `gm` never marks it. The glyphs come straight from the model the review buffer renders, so marking a hunk seen in the review repaints the file immediately.

The projection is deliberately conservative: nothing is painted unless the review targets the work tree (so a post-image line _is_ a buffer line) and the buffer is unmodified since the last model refresh. Editing clears the marks until the next poll. Display-only `min_seen_run` demotion is not applied here — the gutter answers "is this line marked" from the persisted model.

`:Glean toggle-mark` marks lines seen from the file itself. With no range it acts on the whole hunk under the cursor; `:'<,'>Glean toggle-mark` acts on the selected lines. Polarity is "complete, don't flip": the selection is marked unless every line in it is already seen, in which case it is unmarked. Because a gutter row folds in the deletions attached to it, marking a row also marks the deleted lines its `▁` reports. Marks land wherever the reviewed lines belong — per-commit seen ranges for lines blame attributes to a commit in the review, the reviewed work-tree baseline otherwise — exactly as marking the same lines in the review buffer would, and the sign column repaints immediately.

It refuses to act (with a message, leaving the model untouched) on a modified buffer or one whose contents no longer match the work tree the live diff was built from — the latter kicks off a refresh, so re-running it once acts on a fresh model — and on a file whose blame ownership is still loading.

While a buffer is part of the review it also gets glean's buffer-local keymaps: `]c` / `[c` jump to the next / previous hunk (skipping hunks that are fully marked, wrapping at the ends of the file, and falling back to every hunk once the file is fully reviewed), `gj` opens the review at the current line (`:Glean jump`) and `gm` toggles the mark — as an operator taking a motion in normal mode ((`gmm` for the current line, `gmc` for the whole hunk, `gm]c` to the next hunk)), the selection in visual mode. They are installed and removed with the review, alongside the sign column. Set `keymaps = false` in the `gutter` config to keep your own.

The hunk `gmc` would act on is drawn with a heavier glyph (`█`) in the sign column, tracking the cursor, so the target of the keystroke is visible before you press it. Set `focus = false` in the `gutter` config to turn that off.

`gt` (global, `gutter.toggle_key`) toggles the gutter for the current buffer: off, it clears the marks, drops the buffer-local keymaps and hands the sign column back to the other provider until toggled on again. Toggling on with no review open starts the default (`:Glean`) one in the background, so the gutter is also a way into a review without leaving the file. Because it owns the sign column, glean detaches the other sign provider from those buffers (gitsigns, by name, under the default `suppress = "auto"`) and reattaches it when the buffer leaves the review, when the review closes and on exit. Set `suppress = false` to leave the other plugin alone, or pass `{ detach = fn(bufnr), attach = fn(bufnr) }` to drive a different one.

`:Glean toggle-gutter` is the same switch for every buffer at once — it is the runtime form of `gutter.enabled`, so set `enabled = false` to opt in per-session instead of painting automatically. Turning it back on also clears any per-buffer `gt` opt-outs.

Highlight groups: `GleanGutterAdd`, `GleanGutterChange`, `GleanGutterDelete` and the `GleanGutterAddSeen` / `GleanGutterChangeSeen` / `GleanGutterDeleteSeen` variants — all plain, overridable groups.

### Agents

`require("glean.api")` is the programmatic surface. Comments live in the repository rather than in a review, so `comments`, `add_comment`, `reply` and `unreply` work with or without a review open: pass a session id, or `{ repo = "/path/to/repo" }` in the same slot (defaulting to the cwd). Each listed comment reports where it currently resolves (`state` is `"diff"`, `"file"` or `"outdated"`) and the `origin` it was written against (`{ sha, dirty }`). `skills/glean-review/skill.md` documents the surface for agents.

## Keymaps (inside the glean buffer)

- `m` (normal) — toggle seen on the hunk/file/directory/commit under the cursor; on a marker row/line, unmark that run
- `m` (visual) — mark the selected lines seen
- `M` (normal) — unmark the entire hunk under the cursor
- `U` (normal) — unmark everything in the session (undoable with `u`)
- `ac` (visual / operator) — text object selecting the hunk under the cursor (e.g. `vac`)
- `=` — toggle collapse (section, file, directory, commit, or marker row)
- `c` (normal) — comment on the current line
- `c` (visual) — comment on the selected span
- `i` — edit the comment under the cursor
- `dd` — delete the comment under the cursor
- `d` (visual) — delete all selected comments in the comment summary
- `dc` — delete a comment attached to the current line
- `u` / `<C-r>` — undo / redo (seen, comment, collapse actions)
- `]c` / `[c` — next / previous unmarked hunk
- `]f` / `[f` — next / previous file
- `<CR>` — jump to the source line (the live file whenever the line still exists verbatim in the work tree, else a read-only `git show` buffer); on a comment-summary row, navigate to the comment/file in the diff instead
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

glean has no external plugin dependencies — it shells out to `git`. Neovim 0.12+ is required.

## Setup

```lua
require("glean.init").setup({
  default_base = "main",   -- trunk used for fork-point / upstream resolution
  ignore_whitespace = false,  -- start reviews with Git --ignore-all-space display mode
  min_seen_run = 5,        -- combined-scope: demote seen runs shorter than this to unseen
  hunk_indent = 2,         -- display indent for the active hunk body
  hunk_indent_delay_ms = 50,  -- wait before applying the active-hunk indent
  gutter = {               -- review status in the sign column of ordinary files
    enabled = true,        -- paint automatically when a review is live (:Glean toggle-gutter flips it)
    suppress = "auto",     -- "auto" | false | { detach = fn(bufnr), attach = fn(bufnr) }
    toggle_key = "gt",     -- global map toggling the gutter for the current buffer (false to skip)
    focus = true,          -- heavier glyph on the hunk under the cursor (what `gmc` acts on)
  },
})
```

`setup` registers the `:Glean` command and defines the highlight groups (re-derived from `DiffAdd`/`DiffDelete` on every `ColorScheme`).

`ignore_whitespace` selects the initial display mode for newly opened reviews; `W` can change it in place at any time. The mode affects rendered files, hunks, changed lines, and progress counts, but source buffers and persisted review data remain exact.

### `min_seen_run`

When you revisit code you previously reviewed and an agent has since changed it, a single combined-scope hunk can end up with short, scattered runs of previously-seen lines interleaved with newer unseen changes. `min_seen_run` is a display-only threshold (default `5`): in the combined scope, a seen run shorter than `min_seen_run` lines inside an otherwise-unseen hunk is rendered as ordinary unseen `+`/`-` rows instead of a collapsed `✓ marked N lines` marker, so you no longer have to unmark scattered lines by hand. Longer seen runs still collapse to a marker. Set `min_seen_run` to `1` (or `0`) to disable demotion.

The persisted seen store is never touched by this — it stays the plain `(commit, line)` model. If you explicitly re-mark a demoted line as seen in the current context, that mark is recorded as a content-addressed sticky override that keeps the line seen across renders and reopens, and self-invalidates once the line's content changes again.

## Related plugins

Other neovim plugins by [dlants](https://github.com/dlants):

- [magenta.nvim](https://github.com/dlants/magenta.nvim) — transparent tools for agentic AI workflows.
- [needle](https://github.com/dlants/needle) — a fast, signal-aware fuzzy picker.
- [shuck](https://github.com/dlants/shuck) — a streamed shell-command picker (live-grep replacement).
