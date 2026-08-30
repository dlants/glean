# `gm` as an operator (file-buffer marking)

## What changed

`lua/glean/gutter.lua`:

- Added `M.op()`, an `operatorfunc`: it reads `'[` / `']` and calls
  `require("glean.init").toggle_mark(line1, line2)`. Marking is line-granular,
  so charwise/blockwise motions are treated as the lines they touch and the
  motion type argument is ignored.
- `MAPS` (buffer-local, installed by `set_maps` on review membership):
  - `n gm` → `<Cmd>set operatorfunc=v:lua.require'glean.gutter'.op<CR>g@` —
    takes a motion.
  - `n gmm` → same, with `g@_` (current line).
  - `n gmc` → `<Cmd>Glean toggle-mark<CR>` — the old no-range behaviour, which
    expands to the whole hunk under the cursor (`Session:toggle_marks(...,
    expand_hunk = true)`).
  - `x gm` unchanged (marks the selection).

`README.md`'s gutter-keymaps paragraph updated to match. No change to
`M.toggle_mark`, `Session:toggle_marks`, or any store/baseline code, so the
existing suites (`gutter_test`, `toggle_mark_test`) cover the semantics
unchanged; the full suite passes.

## Open item

The user reported the cursor jumping to an unrelated line after `gmm`. Findings
so far:

- Not reproducible headless: a scratch repo + `open_dirty` + `feedkeys("gmm")`
  leaves the cursor on the same line (column moves to first non-blank, per `_`).
- `Session:render()` only restores the cursor into `self.win` (the review
  window); in the reporting session `self.win` was `nil`, so it is not that.
  Nothing in `gutter.lua`'s refresh path moves the cursor.
- The reporting nvim turned out to have a **stale** `glean.gutter` loaded, so
  the observed behaviour was likely the old whole-hunk `gm`. Needs a re-test
  after a restart.

A `CursorMoved` probe was armed in that live session (augroup `GleanProbe`,
appending `{buf, pos, traceback}` to `_G.__glean_probe`) to catch the mover if
it recurs. Remove it with `nvim_del_augroup_by_name("GleanProbe")`.
