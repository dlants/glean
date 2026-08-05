# Objective and Context

User request (verbatim):
> The glean header looks like this sometimes:
>
>      6 ── combined ──  unreviewed: 42 files / 61 hunks / 505 added lines / 86 deleted lines
>      5         ▶ seen (33 hunks)
>      4       ▼ to-event.ts [add]
> ▌    3 --- @@ -0,0 +1,35 @@
> ▌    2   +import type {
> ▌    1   +  Event,
>
> Note that since to-event.ts is visible, we can't see which subdirectory it's
> actually in. If I scroll down so that to-event.ts ends up being part of the
> header, then I can see the full path.
>
> When a file header is visible, I want the floating header to have a line
> showing the directory we're in. Write a plan.

The sticky float already solves the *pinned* case: when a file header has
scrolled above the topline it is pinned into the float, and `M.sticky_text`
rewrites the indented basename into the full path (there are no enclosing
directory rows in the float to give context). The gap is the *visible* case: the
file header is still on screen so it is not pinned, it renders as a bare
indented basename, and its enclosing directory rows have scrolled off — so the
path is unknowable from the screen.

Chosen approach (revised after discussion): rather than a special-cased float
line, **render every directory and file row with its full path** instead of the
trailing component. Rows are spaced out by hunk bodies in practice, so the
repetition costs little and the context is always available — including in the
float, which can then show the pinned row's text verbatim.

Key entities (all in `lua/glean/init.lua`):

- `dir_layout(paths)` / `collapse_chains(out)` — preorder
  `{kind="dir", depth, name, prefix, files}` / `{kind="file", depth, index,
  name}` nodes. `node.name` is the display label (a trailing component, or
  several when a single-child chain was merged); `node.prefix` is the dir's full
  path; a file node's full path is `files[node.index].path`. Indent is
  `("  "):rep(node.depth)`.
- Two emit sites use `node.name`: the commits-scope tree (`emit(...)` for dir and
  file rows, ~line 1362-1381) and the combined-scope tree (~line 1400-1430).
- `M.sticky_text(line, path)` — rewrites a pinned file header's indented basename
  into the full path. Becomes a no-op once rows carry full paths, so it is
  deleted along with its caller-side `row_file` lookup in `Session:update_sticky`.
- `Session:update_sticky` — copies each pinned row's buffer text into the float.
- Path-derived display elsewhere: comment/summary rows and `<CR>` navigation use
  `path` directly and are unaffected.

Files touched:

- `lua/glean/init.lua` — the two tree emit sites; delete `M.sticky_text` and
  simplify `update_sticky`.
- `lua/glean/dirtree_test.lua` — dir-tree layout/render and `sticky_text` tests.
- `lua/glean/init_test.lua` — any assertions matching rendered file-row text.
- `README.md` / `context.md` — the sticky-float note that mentions the basename
  rewrite.

# Design

At both emit sites, replace the label:

- dir row: `node.name` → `node.prefix` (still followed by `/`).
- file row: `node.name` → the file entry's `path`.

Indentation by `node.depth` stays, so the tree shape (and the visual nesting
that makes collapse targets obvious) is unchanged; only the label lengthens.
Chain merging in `collapse_chains` keeps working untouched — it exists to fold
rows away, and the label it synthesizes (`a/b/c`) simply becomes redundant with
the full path.

`M.sticky_text` then has nothing to do: the pinned row's buffer text already
contains the full path, so `update_sticky` writes
`nvim_buf_get_lines(...)[1]` straight into the float and drops the `row_file`
lookup. That removes the one place where float text diverged from buffer text,
restoring "the float is exactly the header rows".

Alternative considered and rejected: the earlier plan's synthetic dir-context
line in the float (a `dir_context` selection rule plus a float row with no
backing buffer row). It solves only the float, leaves the buffer's own file rows
ambiguous when a dir row scrolls off but the file row is still on screen, and
adds a rule (float height ≠ pinned count) that the buffer-projection invariant
otherwise avoids.

Invariants:

- The float's lines remain *verbatim copies* of buffer rows (`#pinned` lines,
  one per pinned row), with the row's own highlight.
- `node.prefix` / `path` are the only label changes; `dirfiles`, collapse keys
  (`dir_key` / `cdir_key`, which key on `prefix`), targets, and `row_map` shapes
  are untouched, so collapse, marking, and navigation are unaffected.
- Chain-merged rows must not double up the prefix (e.g. `a/b/a/b/c`) — the label
  is now taken from `prefix`/`path`, never composed with `node.name`.
- Long paths simply extend past the window edge as today (float has `wrap` off).

# Stages

## full-path row labels

- Goal: every dir and file row in both scopes renders its full path, indented as
  before.
- Tests (`dirtree_test.lua`, real Session over the fake git runner):
  - A nested file `src/deep/b.txt` under an open dir renders as
    `src/deep/b.txt` at its existing indent, and its dir row renders `src/deep/`.
  - A repo-root file renders unchanged (`root.txt`).
  - A single-child chain (`a/b/c/file`) renders the path exactly once — the
    regression this change could plausibly introduce.
  - Collapse/expand of a dir row and `<CR>`-to-file navigation still resolve to
    the same targets (existing tests should pass unmodified).

## sticky float simplification

- Goal: `M.sticky_text` is gone and the float shows pinned rows verbatim.
- Tests:
  - `dirtree_test.lua`: with a nested file's header scrolled above the topline,
    the float's file line equals that buffer row's text and contains the full
    path (replaces the existing `sticky_text` unit assertions).
  - The reported scenario: file header still visible, dir rows scrolled off →
    the visible file row itself now shows the full path, so no float change is
    needed.
  - Full suite (`nvim -l lua/glean/run_tests.lua`) green; update `context.md` /
    `README.md` wording about the float rewrite.
