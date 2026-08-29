# Objective and Context

> let's add the ability to mark and unmark visual selections and the current hunk from the buffer directly. Use `:Glean toggle-mark`

"From the buffer directly" means the *ordinary file buffer* — the one the gutter
already projects the live work-tree review into. Today seen-marking is only
reachable from the glean review buffer (`m`, `M`, `U`, visual `m`) or from
`glean.api.mark` (agents). A reviewer reading the actual file, seeing the gutter
glyphs, has no way to tick lines off without jumping to the review.

Entities involved:

- `Session` (`lua/glean/init.lua`) — the live review. Relevant members:
  - `Session:file_status(path)` (init.lua:954) — the gutter projection for one
    path: post-image `lnum -> GleanGutterMark`. nil unless `self.worktree`.
  - `Session:line_identity(dl, path, owner, ord)` (init.lua:662) — a diff line's
    stable seen-identity; nil for context/unowned lines.
  - `Session:id_seen(id)` (init.lua:708), `Session:combined_owner(path)`,
    `hunk_base_ords(file)` — the ordinal bases `file_status` already feeds
    `line_identity`.
  - `Session:perform({ kind = "seen", op = "mark"|"unmark", ids, sticky })` then
    `Session:render()` — the one mutation + re-projection funnel. `render` calls
    `Session:notify_changed()`, which fires `User GleanReviewChanged`, which the
    gutter listens for (gutter.lua:263) and repaints every file buffer.
  - `Session:row_sticky(target)` (init.lua:2886) — the combined-scope sticky
    record `{ path, text }` for one changed diff line.
- `gutter.project(hunks, is_seen)` (gutter.lua:86) — pure; folds a file's hunks
  into `lnum -> { kind, del_below?, del_above?, seen }`, attributing deletions
  and paired change lines to specific post-image rows via `intraline.pair_lines`.
- `M.current_session()` (init.lua:4704), `git.relpath(repo_root, name)` — how
  gutter.lua and overlay.lua resolve "which review does this buffer belong to".
- The `:Glean` user command (init.lua:5153-5212) — `nargs = "*"`, `range = true`
  already (used by `:Glean comment`), with a subcommand completion list.

Files:

- `lua/glean/init.lua` — Session, the `:Glean` dispatch, keymaps.
- `lua/glean/gutter.lua` — the pure projection and the file-buffer painting.
- `lua/glean/gutter_test.lua`, `lua/glean/init_test.lua` — headless suites.
- `README.md` — user-facing command/keymap docs.

# Design

## Two independent questions

1. *What glyph does a line get?* Answered already by `gutter.project` +
   `Session:file_status`. Untouched by this work.
2. *What does toggling a range of current-text lines mean in identity space?*
   A separate translation, built from scratch, that never consults the gutter.

Bundling (2) into (1) was tempting — one attribution shared by both — but the
gutter's row attribution runs `intraline.pair_lines`, a similarity heuristic,
which has no business deciding what gets persisted. And a gutter row is a
display fold, so marking at row granularity cannot express "this deletion too".

## Translating a current-text range to identities

The file buffer shows the post-image. Every diff line already carries
`new_lnum` (diff.lua:100-114): for an add it is the line's own post-image line;
for a del it is the post-image slot it was removed *from* — the line that now
sits there. So the diff already speaks the buffer's coordinate system.

Selection is two rules over a range `[lo, hi]`:

- **Adds**: every added line whose `new_lnum` falls in the range. This is the
  literal reading of "I have reviewed these lines".
- **Deletions**: a maximal run of deleted lines is selected when it is
  *immediately adjacent, in diff order, to a selected add* — the del run just
  before or just after it in `hunk.lines`. Accepting the resulting text is
  accepting what it replaced: a reviewer who signs off on the new lines is not
  asking to separately sign off on the old ones they no longer see.

A del run with no selected neighbour is additionally selected when its removal
slot is strictly interior to the range (`lo < new_lnum <= hi`) — a deletion that
happened between two lines the reviewer selected. That is what makes a pure
deletion markable from a file buffer at all, and the "strictly interior" test
keeps it unambiguous: a deletion at the very edge of a selection, where it is
genuinely unclear whether the reviewer meant to include it, is left alone.

Note this is per-line, not per-block: selecting one added line of a five-line
added block marks that one line. Only deletions get absorbed, because only
deletions are invisible in the buffer the reviewer is selecting in.

The selection is pure diff geometry — no git, no nvim, no session — so it lives
in `diff.lua` as `M.lines_in_range(hunks, lo, hi)`, returning
`{ hunk, lines = { <index into hunk.lines>, ... } }` entries. `Session` then
folds those indices to identities with the `line_identity` + `hunk_base_ords`
pair it already uses everywhere.

## Storage is unchanged

The command is restricted to work-tree-targeted sessions (`session.worktree`),
since only there does the file buffer's text correspond to the review's
post-image. That is a restriction on the *target*, not on line ownership: in the
combined scope blame still assigns each line an owner, so such a review holds a
mix of committed identities (`add`/`del`, keyed by sha and lnum, stored as
ranges in that commit's shard) and uncommitted `wt` identities (content
addressed, stored as `{ anchor, content[] }` block records in the `WORKTREE`
shard and resolved positionally on read).

Nothing new is needed for either: `Session:apply_seen` (init.lua:2219) already
splits an action's ids into committed and per-path worktree groups and routes
each to its own storage. The new path hands `perform` a mixed id list like every
other caller does.

One property worth preserving: `apply_wt_mark` coalesces ids into block records
by *contiguous ordinal*, and ordinals are flattened diff-line positions. Because
absorbed deletions are diff-order adjacent to their adds, a selection lands as
one contiguous run and stores as a single block record rather than a scatter of
one-line records.

## Sticky records still apply

Display-demotion is invisible in the file buffer, but the lines marked from it
are the same lines the *review* buffer renders. Without a sticky record, a short
run marked from the file buffer would render demoted (as unseen) back in the
review — the same bouncing that made stickiness necessary in the first place. So
the file-buffer mark path records `{ path, text }` for every changed line it
touches and drops them on unmark, exactly like `mark_visual_range`. This costs
nothing: the record is derived from `dl.text` directly, with no identity
plumbing.

## Target resolution

`toggle-mark` resolves a `[lo, hi]` post-image line span in the current file
buffer:

- With a range (`:'<,'>Glean toggle-mark`, or `:10,20Glean toggle-mark`) →
  `o.line1, o.line2`. Note `range = true` gives a bare `:Glean toggle-mark` a
  degenerate range of the cursor line, so the command must distinguish "range
  given" from "no range" via `o.range > 0`.
- Without a range → the *hunk* under the cursor: the enclosing hunk's post-image
  span `[new_start, new_start + new_count - 1]`, clamped to ≥ `new_start` for
  pure-deletion hunks (`new_count == 0`), whose marks land on the row above.
  When the cursor is not inside any hunk the command reports "no change here"
  and does nothing — no nearest-hunk guessing; the gutter shows the reviewer
  exactly where the changes are.

Both paths then reduce to: collect `marks[lnum].ids` for `lnum in [lo, hi]`.

## Toggle semantics

Mirrors `Session:toggle_seen`: if *every* collected identity is already seen →
`unmark`; otherwise → `mark` (marking only the not-yet-seen ones, so the action
inverts exactly). Sticky records are collected for all touched changed lines on
mark, and dropped on unmark, matching `mark_visual_range` / `unmark_hunk`.

One `perform` for the whole span, so it is one undo step.

## Dispatch

`toggle-mark` is added to the `:Glean` subcommand table and its completion list.
It dispatches on the buffer it is run from:

- The glean review buffer → reuse the existing actions, so the command is a
  discoverable alias for the keymaps: range → `session:mark_visual_range`,
  no range → `session:toggle_seen()`.
- Any other buffer → the new file-buffer path above.

This keeps one verb for the user regardless of which surface they are on.

## Alternatives considered

- *Block granularity* (a maximal non-context run is atomic; touching any of its
  adds marks all of it). Rejected: it silently extends a one-line selection to
  lines the reviewer did not select and can still see. Deletion absorption gets
  the property that actually matters — never leaving an invisible del behind —
  without over-reaching on the visible lines.
- *Folding identities into `GleanGutterMark` and marking whatever the gutter
  attributed to the selected rows.* Rejected: it makes a display heuristic
  (`intraline.pair_lines`, plus the deletion-anchor rules) load-bearing for
  persisted state, and it can only ever mark at row granularity, which cannot
  express "this del and its add".
- *Put the logic in `api.lua` and have the command call it.* Rejected for now:
  `api.lua` is the flat JSON agent surface addressing hunks by id, not a
  buffer/lnum surface; a buffer-coordinate entry point there would be a new
  concept. The command talks to the Session directly, like the keymaps do.

## Interfaces

```lua
--- diff.lua — pure. The changed diff lines a post-image range selects: adds
--- with `new_lnum` in [lo, hi], plus del runs adjacent in diff order to one of
--- those adds, plus del runs whose removal slot is interior (lo < new_lnum <= hi).
--- @return { hunk: table, lines: integer[] }[]
function M.lines_in_range(hunks, lo, hi) end

--- The post-image span of the hunk containing `lnum` in `path` (its whole
--- footprint, so a pure-deletion hunk reports its anchor row), or nil.
--- @return integer?, integer?
function Session:file_hunk_span(path, lnum) end

--- Toggle seen for post-image lines [lo, hi] of `path`. Returns the op
--- performed ("mark"|"unmark") and the number of identities changed, or nil
--- when the span carries no changed lines.
--- @return string?, integer?
function Session:toggle_file_range(path, lo, hi) end
```

## Invariants

- A toggle never marks an add while leaving an adjacent deletion of the same
  edit behind: the reviewer cannot see that deletion in the file buffer, so it
  could never be cleared from there, and the hunk would sit permanently short of
  fully-seen with nothing on screen explaining why.
- `gutter.project` and `Session:file_status` are unchanged: nothing about the
  display can influence what gets persisted.
- Marking is idempotent: re-running `toggle-mark` on an all-seen span unmarks it
  and running it again re-marks it, leaving the store where it started.
- One `perform` per invocation → one undo step (`u` in the review buffer).
- Only work-tree sessions are addressable this way: `file_status` returns nil for
  commit-targeted sessions, whose post-image is a snapshot the file buffer may
  have moved past. The command must say so rather than mark the wrong lines.
- A modified (unsaved) buffer has diverged from the model — the gutter clears
  itself in that state (`TextChanged`), and `toggle-mark` must refuse for the
  same reason rather than act on stale line numbers.
- Nothing changes for commit-scope/review-buffer marking; `render` remains the
  only path that repaints and fires `GleanReviewChanged`.

# Stages

## Range selection in diff space

- Goal: `diff.lines_in_range(hunks, lo, hi)` — pure, no session, no gutter.
- Tests (`diff_test.lua`, alongside the existing parser tests):
  - A range covering one added line of a multi-add block selects that line only.
  - A range covering an add that a del run precedes selects the del run too;
    same when the del run follows the add.
  - A del run two lines away from any selected add (separated by an unselected
    add) is not selected — adjacency is in diff order, not "same hunk".
  - A pure-deletion run is selected when its removal slot is interior to the
    range, and not selected when the range merely ends at it.
  - A range over untouched context selects nothing.
  - A range spanning several hunks selects from each.

## Session-level file-range toggle

- Goal: `Session:file_hunk_span` and `Session:toggle_file_range` work against a
  live work-tree session.
- Tests (`init_test.lua`, against a session built from a fake git runner, as the
  existing work-tree suites do):
  - Toggling a span containing a changed line marks both the del and the add
    identity seen — verified through `file_status` reporting the row seen
    *and* through the review buffer's own rendering, so the two surfaces agree.
  - Marking a short run from a file range records sticky overrides, so the
    review buffer renders it as a marker rather than demoting it back to unseen.
  - Toggling the same span again unmarks it, drops the sticky overrides, and
    leaves the store byte-identical to its pre-toggle state (exact reversal).
  - A partially-seen span marks (does not unmark) the remainder; only then does
    a further toggle unmark.
  - `file_hunk_span` returns the enclosing hunk for a line inside it, the
    deletion-anchor row's hunk for a pure-deletion hunk, and nil for a line in
    untouched territory.
  - A commit-targeted (non-worktree) session yields nil from `toggle_file_range`.

## `:Glean toggle-mark` command

- Goal: the command works from a file buffer with and without a range, and
  aliases the existing actions inside the review buffer. Completion offers it.
- Tests (`init_test.lua`, driving `vim.cmd` rather than the Session directly —
  the integration with `range = true` argument handling is where the complexity
  is):
  - `:Glean toggle-mark` with no range in a file buffer marks the whole hunk
    under the cursor, not just the cursor line (the `o.range > 0` distinction).
  - `:'<,'>`-style `:N,M Glean toggle-mark` marks exactly that span.
  - Run from the review buffer with no range it behaves as `toggle_seen`.
  - In a buffer outside the review (or with no live session) it notifies and
    leaves the store untouched.
  - After the command the gutter repaints — assert `GleanReviewChanged` fired
    and the file buffer's signs went grey.

## Docs

- Goal: `README.md` documents `:Glean toggle-mark` next to `:Glean comment`,
  noting the range form, the hunk default, and the work-tree-only restriction.
- Tests: none (prose).
