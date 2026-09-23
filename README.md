# glean
A git diff reviewer that renders the diff of your work tree against a base ref in a single foldable, navigable neovim buffer. The buffer is a read-only projection of a review model; all interaction happens through actions that mutate a persistent review store, so seen-marks and comments survive across sessions.

glean runs in two halves, like [magenta.nvim](https://github.com/dlants/magenta.nvim): a thin Lua layer (commands, keymaps, autocmds, each a single RPC notification) and a node process that owns the model, git, diffing and rendering. Nothing heavy ever runs on the neovim main loop, so a slow git call or a huge diff can delay glean but never freeze the editor. If the backend exits, neovim keeps working and `:Glean` goes away.
## Commands
```vim
:Glean                  " review default_base + the dirty work tree
:Glean open <base>      " review <base> + the dirty work tree
:Glean toggle-mark      " from a file buffer, mark/unmark the hunk or range seen
:Glean toggle-gutter    " turn the sign-column projection on/off everywhere
```
A live review polls the work tree and re-renders in place as files change, preserving the cursor and your collapse state. While the review buffer is hidden it stops painting but keeps tracking the work tree for the gutter.
## Two scopes
Toggle with `S`:
- **combined** (default) — the net diff. Per-line ownership is derived by composing the first-parent patches in the range: additions are credited to the commit that introduced them, deletions to the commit that removed them.
- **commits** — every commit laid out flat. Marks here use a stable `(commit, path, line)` identity, and the same mark shows in the combined view.
## Seen / collapse
Seen-ness is a flat set of line identities. A hunk is seen iff every changed line is seen; files, directories and commits roll up the same way. Seen units render in a collapsible per-file "seen" section, and a seen run inside an otherwise-unseen hunk collapses into a `✓ marked N lines` marker row.

For uncommitted work "seen" means you signed off on a particular version of the line: glean remembers the content you approved and compares it with the file as it is now, so lines you change afterwards come back unseen. Committing resets the seen state for the files the commit touched.

Collapse state is ephemeral view state, initialized from seen status and never persisted.
### `min_seen_run`
In the combined scope, a seen run shorter than `min_seen_run` lines (default 5) inside a partially-seen hunk renders as ordinary unseen rows instead of a marker. This is display-only. Explicitly re-marking such a line records a content-addressed sticky override that keeps it seen until its content changes. Set it to `1` to disable demotion.
### Generated files (`.gleanignore`)
A `.gleanignore` at the repo root (gitignore syntax) declares generated files. Matches are treated as already seen without writing to the store, so removing a pattern brings the file back as unreviewed.
## Comments
Comments are content-addressed records per path, re-anchored to their diff line on every render. Every comment is listed in a summary section at the bottom of the review buffer: `<CR>` on an entry reveals the inline comment, visual `d` deletes the selected comments as one undoable action. Comments are created by agents through the api.
## Keymaps (review buffer)
- `m` (normal) — toggle seen on the hunk/file/directory/commit under the cursor; on a marker row, unmark that run
- `m` (visual) — mark the selected lines seen
- `=` — toggle collapse
- `S` — toggle scope, keeping the cursor on the same line identity
- `u` / `<C-r>` — undo / redo (seen, collapse, comment actions)
- `<CR>` — on a comment-summary row, reveal the comment
- `d` (visual) — delete the selected summary comments
## Gutter in ordinary files
While a review is live, file buffers in the repo get review status in the sign column (add/change/delete, coloured by seen status), replacing gitsigns for those buffers. Buffer-local maps: `]c`/`[c` next/previous hunk, `gmm` toggle the line, `gm{motion}` / visual `gm` toggle a range, `gmc` toggle the hunk (highlighted under the cursor), `u`/`<C-r>` undo/redo marks until the next text edit. `gt` toggles the gutter for the current buffer.
## Agents
`require("glean.api")` is the programmatic surface (sessions, comments, hunks, marking, replies). Each call is a request to the node backend served from memory; a call that can't answer promptly returns `{ status = "pending" }`. `skills/glean-review/skill.md` documents it for agents.
## Installation
Requires Neovim 0.12+, node 22+ and git.
```lua
vim.pack.add({ "https://github.com/dlants/glean" })
-- then build the bundle once (and after updates) from the plugin dir:
--   npm run build
require("glean").setup({})
```
Without a built `dist/glean.mjs` (or with `GLEAN_DEV=1`) glean runs the TypeScript source directly with `node --experimental-transform-types`.
## Setup
```lua
require("glean").setup({
  default_base = "main",     -- base for bare :Glean
  ignore_whitespace = false, -- diff with git --ignore-all-space
  min_seen_run = 5,
  gutter = {
    enabled = true,
    suppress = "auto",       -- "auto" | false | { detach = fn(bufnr), attach = fn(bufnr) }
    toggle_key = "gt",
    focus = true,
  },
})
```
`setup` defines the highlight groups (re-derived on `ColorScheme`) and starts the backend, which registers `:Glean`.
## Related plugins
- [magenta.nvim](https://github.com/dlants/magenta.nvim) — transparent tools for agentic AI workflows.
- [needle](https://github.com/dlants/needle) — a fast, signal-aware fuzzy picker.
- [shuck](https://github.com/dlants/shuck) — a streamed shell-command picker (live-grep replacement).
