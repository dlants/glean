# Objective and Context

Replace the content-addressed representation of seen-ness for **uncommitted**
lines with a stored *reviewed baseline* per file.

The trigger: a worktree seen-mark is stored as a block record
`{ anchor, content = { <diff line texts> } }` and re-found on every render by
`state.resolve` — an all-or-nothing consecutive search of the file's flattened
diff texts, tiebroken by distance from `anchor`. Edit one line of a marked hunk
and the block no longer matches, so:

- every line of the block reverts to unseen, including the untouched ones;
- the record is not pruned (`apply_wt_unmark` deliberately keeps records it
  cannot resolve, init.lua:2286), so it lingers;
- re-marking appends a *new* record beside the zombie, once per edit cycle;
- if that text ever reappears — an undo, or the same run of lines elsewhere in
  the file — the zombie resolves and silently re-marks, possibly in the wrong
  place, with only `anchor` distance guarding it.

This is inherent to the representation. The store holds *text the reviewer once
saw* and re-finds it by search; search can succeed, fail, or succeed in the
wrong place, and there is no outcome meaning "same line, edited". Marking from
an ordinary file buffer (see `plans/2026-08-28-toggle-mark-command.md`) makes
this failure routine, since the reviewer is now marking in the very buffer they
continue to edit.

Entities involved:

- `Store` (`lua/glean/state.lua`) — the sharded persisted review store.
  - `Store:seen_records(path)` / `add_seen_record` / `set_seen_records`
    (state.lua:409-460) — the block records, in the `WORKTREE` shard.
  - `M.resolve(needles, haystack, lnum_of, anchor_lnum)` (state.lua:124) —
    the all-or-nothing re-anchoring search. Also used by comments
    (comments.lua:40), which must keep it.
  - `M.line_hash`, `Store:add_sticky/remove_sticky/is_sticky` (state.lua:465-500).
  - Note state.lua:104-110 still documents a flat set of per-line hashes; the
    block records superseded that and the comment is stale.
- `Session` (`lua/glean/init.lua`)
  - `Session:line_identity(dl, path, owner, ord)` (init.lua:662) — produces
    `{ kind = "wt", path, text, ord }` for uncommitted lines.
  - `Session:wt_flat_texts(path)` (init.lua:967), `Session:wt_seen_ords(path)`
    (init.lua:977), `Session:canonical_ordinal` (init.lua:926) — the ordinal
    space worktree seen-ness is resolved in.
  - `Session:id_seen(id)` (init.lua:708) — the one seen-ness question.
  - `Session:apply_wt_mark(path, ids)` / `apply_wt_unmark(path, ids)`
    (init.lua:2252-2310) — run-coalescing writer and re-anchoring rewriter.
  - `Session:file_status(path)` (init.lua:954) — the gutter projection.
- `Git:show(ref, path)` (git.lua:506) — `git show REF:path`, the base blob.
- `vim.diff(a, b, { result_type = "indices" })` — built-in, pure, returns
  `{ start_a, count_a, start_b, count_b }` hunks. Verified available here.
- `diff.map_lnum(hunks, lnum)` (diff.lua:129) — maps a pre-image line forward
  through a diff, nil when it did not survive.

Files:

- `lua/glean/state.lua` — where the baseline is persisted.
- `lua/glean/init.lua` — Session: seen-ness, marking, rendering.
- `lua/glean/baseline.lua` — new, pure: the classification and edit algebra.
- `lua/glean/state_test.lua`, `baseline_test.lua`, `init_test.lua` — suites.

# Design

## The three versions

The confusion to clear first: "storing a copy of the file" sounds like it just
moves the problem, because a stored copy also goes stale. It does not, because
the copy is never *searched for* — it is only ever *diffed against*, and a diff
is exactly the operation that answers "which lines of this version survived into
that one, and where did they end up".

Three versions of each reviewed file are in play:

- **H** — the file at the review's **tip commit** (the last commit in its
  lineage; for a plain `:Glean` work-tree review with no commits in range, this
  is the base itself). Immutable. This is the pair's left endpoint, *not* the
  review's base: uncommitted lines are exactly the lines of `diff(H, W)`, which
  is why blame attributes them to the synthetic `WORKTREE` commit.
- **W** — the file in the work tree, as it is right now. Moves constantly.
- **R** — the *reviewed baseline*: the content the reviewer has signed off on.
  New; this plan's whole subject. Starts equal to H (nothing reviewed yet) and
  advances toward W one mark at a time.

The uncommitted portion of the display is `D = diff(H, W)`. R sits between:
`diff(H, R)` is the set of changes the reviewer has approved, and `diff(R, W)`
is the set of changes they have not yet looked at.

## Why this fixes the edit case

Mark a hunk seen: R takes on that hunk's new text, so `diff(R, W)` no longer
contains it — every line of the hunk is seen.

Now edit one line of it. W changes; R does not. `diff(R, W)` is recomputed and
contains **exactly that one line's change**. That line renders unseen; its
neighbours, still identical between R and W, stay seen.

Nothing had to be re-found, and nothing partially matched. The per-line
granularity we were about to hand-roll with an LCS "partial re-anchor" is just
what the diff already computes — because a diff is an alignment, and an
alignment is the correct generalisation of the search we are doing today. The
same property covers every case that breaks block records: moving a marked
region within the file (the diff follows it), duplicating a marked line (no
ambiguity — the diff aligns positions, not contents), reverting an edit (the
line matches R again and returns to seen, which is right, since the reviewer did
approve exactly that text).

## Classifying a displayed line, exactly

For each displayed line of `D = diff(H, W)` we must answer seen/unseen. Two
comparisons, each in a coordinate space the two diffs genuinely share — no text
matching, no anchors, no heuristics:

- **An added line of D** (present in W, absent from H), at post-image line `N`.
  It is seen iff it is also in R. `U = diff(R, W)` has W as *its* post-image
  too, so `N` is directly comparable: the line is **seen iff `N` is not an added
  line of U**.
- **A deleted line of D** (present in H, absent from W), at pre-image line `P`.
  It is seen iff the reviewer approved its removal, i.e. iff it is absent from R
  as well. `A = diff(H, R)` has H as *its* pre-image too, so `P` is directly
  comparable: the line is **seen iff `P` is a deleted line of A**.

So adds are decided against `diff(R, W)` and dels against `diff(H, R)`, each by
exact line-number membership in the version the two diffs have in common. This
is the crux of the design and the reason the direction of each diff matters.

## Marking and unmarking as edits to R

Marking is "advance R toward W over the selected lines". Given the selected
displayed lines, walk `U = diff(R, W)` in order and emit R′ line by line:

- context line → keep it;
- added line → include it iff selected (otherwise R′ stays without it);
- deleted line → drop it iff selected (otherwise keep it in R′).

That fold is total and always produces a coherent file: it is a partial patch
application, the parsed-diff equivalent of `git add -p` with line selection.
Unmarking is the mirror image over `A = diff(H, R)`, retreating R toward H.

Mapping a selected *displayed* line to the corresponding line of U (or A) uses
the same shared-coordinate trick as classification: an unseen add is identified
by its W line number, which U shares; an unseen del is identified by its H line
number `P`, which A shares, and reaches U via `diff.map_lnum(A.hunks, P)` — the
existing helper for exactly this. Unmarking an add needs the *reverse* mapping
(W line → R line through U), which is a small new pure helper.

## Where this sits: the stack of reviewed baselines

The general model, which this change makes explicit rather than introduces: a
review is a **stack of reviewed baselines, one per adjacent pair** — `R_i` for
`(c_{i-1}, c_i)`, and a final `R` for `(H, W)`. Marking in a commit's view
touches only that commit's element. The combined view does not compose them by
replaying text (patch application against absent context — the rebase problem,
with the same failure modes); it projects by **blame**: a target line is seen iff
it was marked seen in the view of its owning commit. `provenance.lua` already
computes that ownership. Review order therefore does not matter, because nothing
is replayed or accumulated.

For a committed pair both endpoints are immutable, so line numbers are exact and
the element needs no content — the set of reviewed post-image lines determines
it. That sparse form is precisely the existing `seen_ranges(sha, path)` storage,
and it stays exactly as it is. **This plan changes only the stack's last
element**, whose right endpoint moves and which therefore cannot be represented
by line numbers at all — the reason it is content-addressed today, and the
reason content addressing fails.

## R is anchored on H, and resets when H moves

R only means anything relative to the H it was reviewed against. So it is stored
with its anchor and discarded when that anchor moves:

```
baselines[path] = { base = <hash of H's content for this path>, lines = { ... } }
```

On load and on every refresh, if `hash(H) ~= record.base` the record is dropped
and the path resets to "nothing reviewed". Committing part of the work therefore
clears the seen state for the files it touched, which is the honest answer: the
changes the reviewer approved are no longer the changes on screen.

The anchor is **per path and per content**, not the base sha, for two reasons.
Committing file X must not reset the seen state of untouched file Y — a base-sha
anchor would reset everything. And we already read H's content for the two
diffs, so hashing it costs nothing and needs no extra git call, no dependence on
parsing git's `index` lines, and no special case for a base that is recomputed
to the same tree.

This also bounds the accumulation problem: R cannot carry approvals across a
base change. Within a single H it still accumulates (approve a change, revert
it, and R remembers), which is acceptable — `M` on the hunk, or `U`, resets the
view, and the alternative (renormalising R to "H plus the currently-seen changes
of D" after every refresh) would silently destroy seen state whenever the diff
momentarily collapses, e.g. a half-written file.

## R is stored as content, not as a patch

The compact alternative is to persist `diff(H, R)` — the approved patch — and
reconstruct R by applying it to H. Content wins on simplicity: no reconstruction
step, no partially-applying patch to handle, and the record is directly readable
when debugging. With the anchor above, the two forms behave identically when H
moves (both are discarded), so this is a plain simplicity call rather than a
correctness one.

The cost is storing reviewed files' contents in the `WORKTREE` shard. Bounded by
the anchor reset above, plus pruning: R is dropped when it equals H (nothing
approved) or when the path leaves the review.

## What this deletes

Worktree seen-ness stops being content-addressed, which removes the machinery
that existed only to compensate for content addressing: `wt_flat_texts`,
`wt_seen_ords`, `canonical_ordinal`, `apply_wt_mark`, `apply_wt_unmark`,
`seen_records`/`add_seen_record`/`set_seen_records`, and `state.resolve`'s
seen-mark callers (comments keep it — a comment genuinely wants all-or-nothing,
since a comment whose lines changed is *outdated*, a state it already models).

A worktree identity becomes positional — `{ kind = "wt", path, lnum }` — because
the thing that made it content-addressed (uncommitted lines have no stable line
numbers) is now handled by R. Within a render, post-image line numbers are
stable; across renders seen-ness is recomputed from R rather than carried by
number, so nothing depends on them persisting.

Sticky overrides (`is_sticky`, display-demotion) are unaffected and stay as they
are: demotion is a display rule about run length, orthogonal to how seen-ness is
stored.

## Diffing without git

`diff(H, R)` and `diff(R, W)` are between two in-memory texts, so they cannot
come from `git diff`. `vim.diff(a, b, { result_type = "indices" })` is built in,
pure, and returns hunk index tuples — available headless, so `baseline.lua`
tests the same way `diff.lua` and `intraline.lua` do. H comes from
`Git:show(tip, path)`, W from the work-tree file (or the live buffer).

## Interfaces

```lua
--- baseline.lua — pure. No git, no nvim API beyond vim.diff.

--- Seen-ness for one file. `d` is the displayed diff's hunks (H→W); `base`,
--- `reviewed`, `worktree` are line lists. Returns predicates over displayed
--- diff lines: adds decided against diff(reviewed, worktree), dels against
--- diff(base, reviewed).
--- @return { add: table<integer, boolean>, del: table<integer, boolean> }
function M.seen_sets(base, reviewed, worktree) end

--- R′ after marking `sel` seen. `sel` is `{ add = { <W lnum>, ... },
--- del = { <H lnum>, ... } }` — the same shape the displayed diff yields.
--- @return string[]
function M.mark(base, reviewed, worktree, sel) end

--- R′ after unmarking `sel`. Mirror of `mark`, retreating toward `base`.
--- @return string[]
function M.unmark(base, reviewed, worktree, sel) end

--- state.lua — R persisted in the WORKTREE shard as
--- `baselines[path] = { base = <hash>, lines = {...} }`. Reads return nil when
--- `base_hash` does not match the stored anchor, so a moved H reads as unreviewed.
function Store:baseline(path, base_hash) end          --- @return string[]?
function Store:set_baseline(path, base_hash, lines) end --- nil/equal-to-base prunes
```

## Invariants

- Marking then unmarking the same selection restores byte-identical JSON, as
  the current implementation is careful to do.
- Marking is idempotent: R′ computed twice from the same selection is R′.
- Editing a marked line makes *that line* unseen and leaves every other line of
  its hunk seen. This is the whole point of the change.
- Reverting an edit restores the seen state, since the line matches R again.
- No stored state is ever located by search, so no record can resolve at the
  wrong place, and none can outlive its subject.
- R is only meaningful for uncommitted lines. Committed lines keep their
  `(sha, lnum)` range storage untouched — this plan does not go near it.
- R may drift outside the interval [H, W] (restore a line you approved deleting,
  and R lacks a line both H and W have). Harmless by construction: seen-ness is
  only ever asked about lines that appear in D, and classification ignores the
  rest.
- A baseline is never interpreted against an H it was not reviewed against: the
  stored anchor is checked on every read, and a mismatch reads as unreviewed
  rather than as a diff against stale content.
- A commit resets seen state for exactly the paths whose base content moved, and
  leaves every other path's baseline intact.

# Stages

## Pure baseline algebra — DONE

- [x] Goal: `lua/glean/baseline.lua` with `seen_sets`, `mark`, `unmark`, plus the
  reverse post→pre line mapping helper. No session, no store, no git.
- Decisions:
  - The module exposes `align(a, b)` (a full-file op list built from
    `vim.diff` indices) plus `map_forward` / `map_back` over that op list, and
    the three planned entry points are written against it. `diff.map_lnum` is
    not reused: it wants parsed `git diff` hunks, not `vim.diff` indices.
  - `seen_sets` returns *dense* tables (`add` keyed 1..#worktree, `del` keyed
    1..#base) so a missing key is never ambiguous; lines outside D read seen
    but are never asked about.
  - `mark`/`unmark` take `sel = { add = { <W lnum> }, del = { <H lnum> } }` as
    lists (converted to sets internally).
- Deviation: the planned "move a marked region elsewhere in the file stays
  seen" case does not hold — `vim.diff` is not move-aware, so a wholesale move
  reads as a delete plus a fresh insertion and the moved region is unseen. The
  test covers the case that does hold (a region *shifted* by an edit above it
  stays seen) and documents the limitation.
- Tests (`baseline_test.lua`, three literal line-lists per case):
  - Mark a hunk, then change one line of W: exactly that line is unseen, the
    rest of the hunk stays seen. Run the same case with the edited line at the
    start, middle, and end of the run.
  - Mark a hunk, then *insert* a line into the middle of it: the new line is
    unseen, both halves stay seen (the alignment case block records cannot do).
  - Move a marked region elsewhere in the file: it stays seen.
  - Two identical marked lines far apart: marking one leaves the other unseen
    (the ambiguity that content hashing cannot express).
  - Revert an edit: the line returns to seen.
  - Deletions: marking a del removes it from R and it reads seen; restoring the
    deleted line in W leaves classification well-defined and marks nothing.
  - `mark` is idempotent; `unmark` inverts `mark` exactly.
  All of the above are covered in `lua/glean/baseline_test.lua` (30 asserts),
  plus empty-endpoint cases (new file, whole-file deletion).

## Store: baselines replace block records

- Goal: `Store:baseline` / `set_baseline` persist under `baselines[path]` in the
  `WORKTREE` shard; block-record APIs and their pruning are removed.
- Tests (`state_test.lua`):
  - A baseline read back with a different `base_hash` returns nil, and the stale
    record is not resurrected by a later read with the original hash.
  - Set then clear a baseline restores byte-identical shard JSON, and the shard
    is pruned when it holds nothing else (the existing round-trip property).
  - A baseline equal to the base content is not persisted.
  - A store carrying legacy `seen_marks` loads without error and, on first
    write, is migrated: the legacy records are resolved once with the old
    algorithm, folded into a baseline, and dropped. Assert the resulting seen
    set matches what the old code reported for the same store.

## Session: classification and marking through R

- Goal: `id_seen`, `file_status`, `apply_seen` and the worktree identity route
  through `baseline.lua`; the ordinal/content machinery listed above is deleted.
- Tests (`init_test.lua`, sessions built against the fake git runner):
  - Mark a hunk in the review buffer, rewrite one line of the work-tree file,
    poll: the review buffer shows exactly that line unseen and the file-buffer
    gutter greys exactly the same rows. Both surfaces, one model.
  - The zombie case from the objective: mark, edit, re-mark, revert the edit —
    the store holds one baseline and no line is spuriously seen.
  - Commit the marked change so H moves: that path's baseline is discarded and
    its remaining uncommitted changes read unseen, while an untouched path in
    the same session keeps its baseline and its seen state.
  - Marking is one `perform` and one undo step, as today.
  - A session with no uncommitted changes writes no baselines.

## Docs

- Goal: `context.md`'s line-identity section and `state.lua`'s stale
  per-line-hash comment (state.lua:104-110) describe R. `README.md` gains a
  sentence on what "seen" means for uncommitted work: you signed off on a
  version of the line, and only the parts you subsequently change come back.
- Tests: none (prose).
