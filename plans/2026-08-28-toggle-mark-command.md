# Objective and Context

> let's add the ability to mark and unmark visual selections and the current hunk from the buffer directly. Use `:Glean toggle-mark`

"From the buffer directly" means the _ordinary file buffer_ — the one the gutter already projects the live work-tree review into. Today seen-marking is only reachable from the glean review buffer (`m`, `M`, `U`, visual `m`) or from `glean.api.mark` (agents). A reviewer reading the actual file, seeing the gutter glyphs, has no way to tick lines off without jumping to the review.

Entities involved:

- `Session` (`lua/glean/init.lua`) — the live review. Relevant members:
  - `Session:file_status(path)` (init.lua:944) — the gutter projection for one path: post-image `lnum -> GleanGutterMark`. nil unless `self.worktree`.
  - `Session:line_identity(dl, path, owner)` (init.lua:671) — a diff line's seen-identity; nil for context/unowned lines. A worktree-owned line is `{ kind = "wt", path, lnum, dkind }`, positional: `lnum` is the work-tree line for an add and the tip-commit line for a del.
  - `Session:id_seen(id)` (init.lua:697) — worktree ids read the path's `baseline.seen_sets`; committed ids delegate to the store.
  - `Session:perform({ kind = "seen", op = "mark"|"unmark", ids, sticky })` then `Session:render()` — the one mutation + re-projection funnel. `render` calls `Session:notify_changed()`, which fires `User GleanReviewChanged`, which the gutter listens for (gutter.lua:263) and repaints every file buffer.
  - `Session:apply_wt_seen(path, ids, op)` (init.lua:2266) — folds worktree ids into a `{ add, del }` selection for `baseline.mark`/`unmark`, then writes the new R.
  - `Session:wt_versions(path)` (init.lua:976) — the memoized `{ base (H), reviewed (R), worktree (W), base_hash }` triple for one path.
  - `Session:row_sticky(target)` (init.lua:2850) — the combined-scope sticky record `{ path, text }` for one changed diff line.
- `baseline.mark/unmark(base, reviewed, worktree, sel)` (`lua/glean/baseline.lua`) — pure. Selected adds are named by work-tree line, selected dels by tip-commit line.
- `gutter.project(hunks, is_seen)` (gutter.lua:86) — pure; folds a file's hunks into `lnum -> { kind, del_below?, del_above?, seen }`, attributing deletions and paired change lines to specific post-image rows via `intraline.pair_lines`.
- `M.current_session()` (init.lua:4704), `git.relpath(repo_root, name)` — how gutter.lua and overlay.lua resolve "which review does this buffer belong to".
- The `:Glean` user command (init.lua:5153-5212) — `nargs = "*"`, `range = true` already (used by `:Glean comment`), with a subcommand completion list.

Files:

- `lua/glean/init.lua` — Session, the `:Glean` dispatch, keymaps.
- `lua/glean/gutter.lua` — the pure projection and the file-buffer painting.
- `lua/glean/gutter_test.lua`, `lua/glean/init_test.lua` — headless suites.
- `README.md` — user-facing command/keymap docs.

# Design

```
B - base version of the file
H - head version of the file
W - worktree version of the file
R - the reviewed part of the worktree file, sits between H and W
diff(B,W) - the full diff of the session
C - the combined view of diff(B,W), with marks, folds, etc... applied on top

gutter maps from diff(B,W) coordinates to W coordinates
operating on C maps to diff(B,W), then applies the operations on the mark store and R
so we just need to add info to the gutter to allow us to map from W to diff(B,W), at which point we will use our existing code to translate that into operations on the mark store and on R
```

Each view needs an inverse back into `diff(B, W)`'s coordinates; everything downstream of the inverse is already shared.

Coordinates, outermost to innermost:

- buffer rows — ephemeral, rebuilt per render, filtered by collapse state, seen sections and `min_seen_run` demotion. Never a durable handle.
- `{cfile, hunk, line}` — a position in `diff(B, W)`: `combined_files[cfile] .hunks[hunk].lines[line]`. `cfile` is an index into `combined_files`; valid only against the live list, which is nilled whenever the model is rebuilt.
- identity (`add` / `del` / `wt`) — the persisted address the store and the reviewed baseline speak.

`row_map[row] -> {cfile, hunk, line}` is C's inverse. The file buffer needs the same thing, minus `cfile`: it is single-file by construction, so the path is ambient (`M.current_session()` + `git.relpath`), and threading a file handle into `gutter.project` would push file identity into a pure function that has no use for it.

## Pre-work: make the coordinate systems legible

Mechanical renames, no behaviour change, landed before the feature so the new
code has unambiguous names to use. Suite must stay green (`nvim -l
lua/glean/run_tests.lua`).

Status: done (stage 2). `row_map` targets now use `li` (renamed from `line`)
across `init.lua` and every test suite; construction sites and all predicate
reads updated. Doc comments added at the `lnum` boundaries that lacked one:
`state.M.wt_identity` (work-tree line for an add, tip-commit line for a del) and
the `row_map` target shape above `Session:build` (both `hunk` and `li` are
indices, never line numbers). The other boundaries (`line_identity`,
`combined_owner`/`commit_owner`, `wt_seen_sets`, `apply_wt_seen`,
`gutter.project`, `Session:file_status`, `baseline.lua`'s header) already
documented their coordinate space and were left as-is. Suite green.

Status: done (stage 1). `Session:wt_base_lines`→`wt_head_lines`,
`_wt_base`→`_wt_head`, `wt_versions`'s `base`/`base_hash`→`head`/`head_hash`,
`baseline.seen_sets/mark/unmark`'s first parameter→`head`, and the persisted
`rec.base`→`head` in `state.lua` (no back-compat read; existing stored baselines
read as unreviewed). `git.lua`'s `base` parameters already mean B and were left
alone. The `target.line`→`li` rename and the `lnum`-space doc comments are not
part of this stage. Suite green.

- `base` currently means both B and H. Reserve it for B (`Session.base`,
  `opts.base`, every `base` parameter in `git.lua`) and rename the H-meaning
  ones to `head`: `Session:wt_base_lines` → `wt_head_lines`, `self._wt_base` →
  `_wt_head`, the `base` / `base_hash` fields of `Session:wt_versions` → `head` /
  `head_hash`, and `baseline.seen_sets/mark/unmark`'s first parameter → `head`
  (its doc comment already has to explain "base (H)", which is the tell).
- `target.line` in `row_map` is an index into `hunk.lines`, not a line — and it
  sits beside `hunk`, which *is* an index. Rename to `li`, matching the existing
  local convention (init.lua:1361, 3103). This also fixes the name for the new
  gutter entries: `sources = { { hunk = i, li = j } }`.
- `lnum` legitimately spans four spaces (`new_lnum`, `old_lnum`, a work-tree
  line, a tip-commit line) and `wt_identity(path, lnum, dkind)` is positional
  between the last two by design. Not renamable — it is a persisted field and the
  polymorphism is the point. Fix with a doc comment at each boundary stating
  which space is meant.
- `state.lua`'s `rec.base` (the H content-hash anchor) is persisted on disk, so
  renaming it to `head` invalidates stored baselines. Acceptable: no back-compat
  read, the affected paths simply read as unreviewed until re-marked.

## Decision

`M.project` retains, per post-image row, the coordinates of the diff lines it folded in: `sources = { { hunk = i, line = j } }`. The forward pass already holds both indices, so this is free, and `gutter.project`'s signature is unchanged. Nothing else is retained — not `dl`, not a resolved identity.

Status: done (stage 3). `fold` now takes the folded *entries* rather than a
bare `seen` flag, and both accumulates `m.seen` and appends each entry's
`src = { hunk = hi, li = i }` to `m.sources`; the `hunk` index is into the
file's hunk list. Change rows carry both the add and its paired del, an anchored
or `del_above`/`del_below` deletion carries its own coordinate. Signature,
`GleanGutterMark` rendering and every existing assertion unchanged; five new
`gutter_test.lua` cases cover add, change-pair, unpaired dels attached to the
change row, `del_above`, and multi-hunk indexing. Suite green.

`:Glean toggle-mark` then: resolve path from the buffer → union `sources` over the selected rows (or the cursor row's hunk when given no range) → map each through `line_identity(dl, path, self:combined_owner(path))` → hand the ids to the existing `Session:perform({ kind = "seen", ... })` + `render()`. The repaint follows from `GleanReviewChanged`, which the gutter already listens for.

Status: done (stage 4). `Session:toggle_marks(path, srow, erow, expand_hunk)`
(init.lua, right before `wt_head_lines`) is the inverse: it reads
`self:file_status(path)`, unions the rows' `sources` (deduped by `hunk:li`),
widens them to whole hunks when `expand_hunk` (the no-range, cursor-row case),
maps each through `line_identity` with `combined_owner`, and performs one
`{kind = "seen"}` action + `render()`. Polarity is `ids_all_seen` -> unmark,
else mark. Every addressed changed line also contributes a `{path, text}` sticky
record, matching `mark_visual_range`. Unlike `mark_visual_range` the already-seen
ids are *not* filtered out of the mark payload: both the store and
`baseline.mark` are idempotent there, and the unmark direction needs them.
Guards: `file_status` nil (not worktree-targeted / path not in the review),
`load_lineage()` then `owner_status(path) ~= "loaded"` (pending ownership), and
an empty id set (a pure-context selection) all return `false, reason` rather
than acting. `M.toggle_mark(line1, line2)` is the buffer-side entry point —
`current_session()` + `git_mod.relpath`, refusing a `modified` buffer (chosen
over forcing a refresh: it is the same rule the gutter already paints by, so a
stale glyph and a refused mark agree) — and the `:Glean` dispatch routes
`toggle-mark` to it, with `o.range > 0` deciding range vs. cursor-hunk.
`toggle-mark` added to the completion list. New suite
`lua/glean/toggle_mark_test.lua` (range mark, all-seen toggle back, partial
completes, hunk expansion, inert context row / unknown path). Full suite green.
No README/keymap changes in this stage.

Status: done (stage 5). The pending-blame guard shipped with stage 4 and is now
covered: `Session:toggle_marks` calls `load_lineage()` and refuses with
"ownership still loading" when `owner_status(path) ~= "loaded"`. For staleness,
`Session:wt_matches(path, lines)` (init.lua, just before `wt_head_lines`)
compares a buffer's lines against `wt_file_lines(path)` — the work-tree content
the live diff was actually built from — and `M.toggle_mark` refuses when they
differ, kicking off a `session:poll()` so the next invocation acts on a fresh
model ("refresh, then try again" rather than a silent refresh-and-mark, which
would mark rows the reviewer never saw). This subsumes the earlier `modified`
check (kept, as the cheaper and more specific message) and also catches a file
changed on disk since the last poll. Tests live in `toggle_mark_test.lua`
alongside the rest of the feature rather than `init_test.lua` (deviation from
the plan's wording; same suite runner, better colocation): pending-ownership
inertness plus `wt_matches` for matching / edited / truncated / unknown-path
content. Suite green.

Why deferred coordinates rather than pre-resolved identities:

- `line_identity` needs `owner(dl)`, i.e. loaded blame provenance. Resolving during projection would make the gutter depend on it; resolving at mark time keeps `M.project` pure and headless-testable.
- `diff(B, W)` spans both regimes. `combined_owner` returns `(sha, lnum)` for a line blame attributes to a commit in `B..H` and falls through to `WORKTREE` otherwise. So "propagate into per-commit seen marks" is not a second pass — it is the same call, and for any session with a non-trivial `B` it is the majority path.
- Nothing copies buffer text into R. The worktree ids fold into `Session:apply_wt_seen`'s `{ add = { <W lnum> }, del = { <H lnum> } }` selection and `baseline.mark/unmark` derives the R edit from the (H, R, W) alignment itself. Lines already context in `diff(R, W)` are no-ops there, so a coarse whole-range union is safe to pass unfiltered.

Consequences to handle:

- The gutter's forward map is many-to-one where `row_map`'s is one-to-one: `fold` collapses paired change lines and attached deletions onto a single post-image row, and a deletion occupies no row of its own. The inverse is therefore set-valued — marking one row can mark several identities, including a deletion rendered as `del_below`. This is the semantics the greyed glyph already reports.
- Toggle polarity: mark unless every source in the selection is already seen, so a partially-seen selection completes rather than flips.
- Pending ownership: `combined_owner` yields the all-nil owner until blame lands and `row_identity` asserts `owner_status(path) == "loaded"`. The command needs the same guard C's actions have (a pending file is inert) rather than silently marking nothing.
- A modified, unsaved buffer is not `W`, so the gutter is stale and a `{hunk, line}` can name a line the user is not looking at. Reuse the existing work-tree signature check and refuse (or force a refresh) rather than mark against a diff that no longer describes the buffer.
