# Objective and Context

## User request (verbatim)

> this approach works for me. Write out a plan

referring to:

> The principled fix: stop deriving del-seen-ness from R at all. H is the tip
> commit — immutable, and the baseline record is already anchored by its hash —
> so seen deletions can be stored as an explicit set of head line numbers,
> leaving R to cover only adds (where W's shifting line numbers are the actual
> reason R exists). That kills the whole ambiguity class, at the cost of a
> change to the `WORKTREE` shard's baseline record and to
> `plans/2026-08-28-reviewed-baseline.md`.

## The bug this fixes

Uncommitted seen-ness is currently derived by composing two independent
`vim.diff` alignments: `align(head, reviewed)` decides which head lines are
approved deletions, `align(reviewed, worktree)` decides which work-tree lines
are approved additions. When a line's text repeats nearby (`--`, `}`, a blank
line) the two alignments disagree about *which copy* of the duplicate is the
deleted one. Two symptoms follow, both observed against
`~/src/gatherus/custom-fields-to-person-sheet`, `packages/backend/db/schema.sql`:

- `baseline.mark` is a silent no-op. It drops the selected R line only when
  `align(reviewed, worktree)` gives that line the `del` role; when the other
  alignment pairs it with a surviving work-tree copy instead, R comes back
  byte-identical and the line is unmarkable forever. Live repro: head line 153
  (`--`) in the `@@ -149,34 +150,6 @@ END;` hunk — 27 of 28 lines mark, the hunk
  never closes.
- `baseline.seen_sets` misclassifies even when the mark did land, because
  `align(head, reviewed)` re-picks which copy is deleted. Minimal repro
  (`/tmp/t2.lua`): H = `$$;`, ``, `--`, `-- Name: A`, `--`, ``, `BODY A`, ``,
  `--`, `-- Name: B`, `--`, ``, `BODY B`; W keeps only the B block; marking
  every displayed del except head 5 leaves head 9 stuck unseen.

Both symptoms are captured by `lua/glean/wt_dup_lines_test.lua`, written before
this plan and committed with it. It builds a real temp repo whose work tree
deletes one of two `--`-delimited blocks and drives a Session through the public
marking path (`changed_lines` / `line_identity` / `perform` / `id_seen` /
`hunk_seen`), so it is independent of the algebra's internal shape and does not
change across the stages below. It fails 8 assertions on `main`.

The first symptom has a band-aid already applied in the working tree
(`mark`/`unmark` drop the selected R line whatever role the other alignment
gave it). That change is subsumed by this plan and should be reverted as part
of stage 1.

The root cause is that a deletion's seen-ness is *derived by re-diffing*, and
that derivation is ill-posed under duplicate lines. Deletions do not need the
derivation: they are named by head line numbers, and H is the review's tip
commit — immutable for the life of a baseline record, which is already anchored
by `content_hash(H)`. Only *additions* need R, because work-tree line numbers
shift under editing.

## Key entities

- `glean.baseline` (`lua/glean/baseline.lua`) — the pure algebra. Today:
  `align(a, b) -> Op[]`, `map_forward(ops, a_lnum)`, `map_back(ops, b_lnum)`,
  `seen_sets(head, reviewed, worktree) -> { add: table<int,bool>, del: table<int,bool> }`,
  `mark(head, reviewed, worktree, sel) -> string[]`,
  `unmark(head, reviewed, worktree, sel) -> string[]`, where
  `sel = { add = { <worktree lnum>... }, del = { <head lnum>... } }`.
- `Store:baseline(path, head_hash)` / `Store:set_baseline(path, head_hash, lines)`
  (`lua/glean/state.lua:455,466`) — the persisted record
  `baselines[path] = { head = <sha256 of H>, lines = R }` in the always-loaded
  `WORKTREE` shard. `set_baseline` prunes the record when `lines` is nil or
  content-identical to H, which is what keeps mark-then-unmark byte-identical.
- `M.add/remove/covers/merge` (`lua/glean/state.lua:31-94`) — the existing
  inclusive `{lo, hi}` range-list algebra used by `seen`/`seen_del`. The new del
  set reuses it verbatim.
- `Session:wt_versions(path)` (`lua/glean/init.lua:1065`) — `{ head, head_hash,
  reviewed, worktree }`, cached per path, invalidated on write and on reload.
- `Session:wt_seen_sets(path)` (`lua/glean/init.lua:1083`) — caches
  `baseline.seen_sets(...)`; read by `Session:id_seen` (`init.lua:704`) for
  `kind == "wt"` identities via `id.dkind`.
- `Session:apply_wt_seen(path, ids, op)` (`lua/glean/init.lua:2361`) — the only
  writer: splits ids into `sel.add`/`sel.del` by `dkind`, calls
  `baseline.mark`/`baseline.unmark`, `store:set_baseline`, and drops the
  `_wt_versions` / `_wt_seen` caches.
- `M.wt_identity(path, lnum, dkind)` (`lua/glean/state.lua:728`) — unchanged;
  a del identity's `lnum` is already the tip-commit line number.
- `M.migrate_shard` (`lua/glean/state.lua:224`) — precedent for handling legacy
  shard shapes on read (`seen_marks` is dropped outright).

## Relevant files

- `lua/glean/baseline.lua` — the algebra; loses all del handling.
- `lua/glean/baseline_test.lua` — pure tests, `render`/`all_sel` helpers.
- `lua/glean/state.lua` — the persisted record shape and its pruning.
- `lua/glean/state_test.lua` — store-level tests.
- `lua/glean/init.lua` — `wt_versions`, `wt_seen_sets`, `apply_wt_seen`.
- `lua/glean/toggle_mark_test.lua`, `lua/glean/dirty_combined_test.lua`,
  `lua/glean/gutter_test.lua`, `lua/glean/api_test.lua` — end-to-end coverage of
  the worktree marking path through a real Session.
- `plans/2026-08-28-reviewed-baseline.md` — the design doc this supersedes in
  part.
- `context.md` — the developer guide's statement of the algebra.

# Design

Split the uncommitted seen model in two, by the stability of the coordinate each
side is named in:

- **Deleted lines** are named by head line numbers. H is immutable while the
  record lives (the record is anchored by `content_hash(H)`, and a moved tip
  drops it wholesale), so the seen set is stored *explicitly* as a list of
  inclusive `{lo, hi}` ranges of head line numbers. No diff is consulted;
  marking is a range insert, unmarking a range remove, and classification is
  `M.covers`.
- **Added lines** keep the reviewed baseline R exactly as today: an add at
  work-tree line N is seen iff it is not an add of `diff(R, W)`. Work-tree line
  numbers shift under editing, which is the whole reason R exists, and the
  observed ambiguity does not bite here (adds are classified against R, and
  marking an add *inserts* the exact selected text at the exact position the
  alignment already agrees on).

R therefore stops carrying deletions. `baseline.mark` no longer removes lines
from R; R is only ever grown toward W. Concretely, R becomes "H plus the
work-tree additions the reviewer has approved", and `diff(H, R)` is guaranteed
to be add-only — a property worth asserting in tests, since it is what makes
the remaining derivation single-sided and therefore unambiguous.

### Why not canonicalize the alignments instead

Considered and rejected: making the three diffs agree (a shared tokenization, a
3-way alignment, forcing `indent_heuristic`) still leaves an arbitrary choice
among equally valid alignments, and the choice would have to be stable across
`vim.diff` versions and across every edit of W. Storing the head line numbers
removes the question rather than answering it.

### Migration

The record grows a `dels` field. A record written by the old code has `lines`
but no `dels`, and its deletions are encoded implicitly in `lines`. Rather than
dropping that state (the `seen_marks` precedent) we can recover it exactly once,
in the Session, which is the only layer that holds H:

- `Store:baseline` returns the raw record (`{ head, lines, dels }`) instead of
  just `lines`, still nil on anchor mismatch.
- `Session:wt_versions` builds `reviewed` and `dels` from it. When `dels` is
  absent (a legacy record) it derives the del set from `align(head, lines)` —
  the same computation the old `seen_sets` did — and *re-canonicalizes* `lines`
  to `H + approved adds` by re-inserting every deleted line. The migrated pair
  is written back on the next mark; no separate migration pass and no upgrade
  step for the user.
- A legacy record can therefore still mis-attribute a duplicate line at the
  moment of migration (that is the bug, frozen into the stored R), but from then
  on the state is explicit and the line is markable. This is strictly better
  than today and better than discarding the record.

## Interfaces

`lua/glean/baseline.lua` — del handling removed:

```lua
--- Seen-ness of the added lines of D = diff(head, worktree), keyed by
--- work-tree line number. Deleted lines are not decided here (see
--- Store baselines[path].dels).
--- @return table<integer, boolean>
function M.seen_adds(reviewed, worktree)

--- R' after marking work-tree lines `sel_add` seen. Grows R toward W; never
--- removes a line from R.
--- @param sel_add integer[] work-tree line numbers
--- @return string[]
function M.mark_adds(reviewed, worktree, sel_add)

--- R' after unmarking work-tree lines `sel_add`.
--- @return string[]
function M.unmark_adds(head, reviewed, worktree, sel_add)
```

`align`, `map_forward`, `map_back` keep their current signatures.
`M.seen_sets`, `M.mark`, `M.unmark` are deleted (no callers remain).

`unmark_adds` still needs `head`: an add is removed from R only if it is not a
head line, so the walk stays over `align(head, reviewed)` as today, minus the
del branch (which now never fires, since `diff(head, reviewed)` is add-only).

`lua/glean/state.lua` — record and accessors:

```lua
-- WORKTREE shard
baselines[path] = {
  head = "<sha256 of H's lines>",
  lines = { "<R line>", ... },   -- omitted when R == H
  dels  = { { lo, hi }, ... },   -- head line numbers, inclusive, merged
}

--- The whole record for `path`, or nil on anchor mismatch / no record.
--- @return { head: string, lines: string[]|nil, dels: {[1]:integer,[2]:integer}[]|nil }|nil
function Store:baseline(path, head_hash)

--- Write `path`'s record. Prunes when `lines` is nil-or-content-identical to
--- the head hash *and* `dels` is empty, preserving the byte-identical
--- mark/unmark invariant.
function Store:set_baseline(path, head_hash, lines, dels)
```

`lua/glean/init.lua`:

```lua
--- @return { head: string[], head_hash: string, reviewed: string[],
---           dels: {[1]:integer,[2]:integer}[], worktree: string[] }
function Session:wt_versions(path)

--- @return { add: table<integer, boolean>, del: table<integer, boolean> }
--- `add` from baseline.seen_adds; `del` a covers() view over v.dels.
function Session:wt_seen_sets(path)
```

`Session:id_seen` and every other reader are untouched: `wt_seen_sets` keeps its
shape.

## Invariants

- `diff(head, reviewed)` is add-only for every record this code writes. R is
  never shrunk below H.
- Marking then unmarking the same selection restores the store to
  byte-identical JSON (the existing store invariant — `set_baseline` must prune
  on *both* `lines` and `dels` being empty).
- A del identity's seen-ness depends only on `dels` and the anchor: for a fixed
  H, marking head line P then re-reading always reports P seen, regardless of
  how many copies of that text the file contains. This is the property the
  current design violates.
- A moved tip commit still drops the whole record (anchor mismatch), dels
  included — committing part of the work resets exactly the paths whose
  tip-commit content changed.
- Marking a del must not perturb the seen-ness of any add, and vice versa. The
  two halves no longer share a representation, so this is by construction.
- Editing a marked *added* line still makes exactly that line unseen and leaves
  its neighbours seen (existing behaviour, must not regress).
- Deleting a line, marking it seen, restoring it, and deleting it again reports
  it seen without a fresh mark. Accepted: it is the same line of the same
  immutable H, and the record dies as soon as H moves.
- A legacy record (no `dels`) reads as the old code read it, and is rewritten in
  the new shape on the next mark of that path.

# Stages

## 1. baseline: adds-only algebra

**Status: done** (stage 1 commit). Deviation: `M.seen_sets`/`mark`/`unmark`
were *not* deleted — they are kept, reverted to their pre-band-aid form and
marked DEPRECATED in `baseline.lua`, so `init.lua` keeps running while stage 1
lands on its own. Stage 2 deletes them once `wt_seen_sets`/`apply_wt_seen`
move to the new surface. `baseline_test.lua` now covers only the new adds-only
surface; the deprecated del path stays covered by the session-level suites.
`wt_dup_lines_test.lua` still fails exactly its 8 pre-existing assertions.

- Goal: `glean.baseline` no longer knows about deletions. `seen_adds`,
  `mark_adds`, `unmark_adds` replace `seen_sets`, `mark`, `unmark`; the working
  tree's band-aid in `mark`/`unmark` is reverted along with the code it patched.
  Nothing outside `baseline.lua` compiles against the old names, so this stage
  lands together with stage 2's call-site updates or behind a brief adapter —
  prefer landing 1+2 as one commit if the intermediate state cannot run.
- Acceptance: `wt_dup_lines_test.lua` still fails (this stage does not reach the
  del path) but must not fail *differently* — no new assertion may break.
- Tests (`baseline_test.lua`, rewritten around the new surface):
  - Marking an add, then editing that work-tree line, leaves the edited line
    unseen and its marked neighbours seen.
  - `mark_adds` never shortens R: assert `#R' >= #R` and that `align(head, R')`
    contains no `del` op, over the duplicate-heavy fixture from the bug report.
  - `unmark_adds` inverts `mark_adds` exactly (existing test, retained).
  - Marking all adds of a new file yields R == W (existing empty-endpoint
    tests, retained).

## 2. store + session: explicit del ranges

**Status: done** (stage 2 commit). Deviations:
- The deprecated `baseline.seen_sets`/`mark`/`unmark` are deleted here, as
  stage 1 deferred; `baseline.lua`'s header comment now states the split model.
- `Store:baseline` returns the raw record, so the three call sites in
  `state_test.lua` / `init_test.lua` that indexed the returned lines directly
  now go through `.lines`.
- `Session:wt_seen_sets().del` is a `__index` metatable view over `v.dels`
  rather than a materialized table, so it stays O(1) per read and needs no
  bound on head length. Only `Session:id_seen` reads it, and only by index.
- The legacy-record test lives in `wt_dup_lines_test.lua` (it needs the real
  repo harness) and asserts *recovery*, not perfection: on the duplicate-heavy
  fixture the migration inherits the old mis-attribution for one of the six
  deletions (5/6 read seen), then the first mark rewrites the record with
  explicit `dels` and add-only `lines` and the hunk closes. This is the
  behaviour the design section anticipated.
- Live check ran green: base `1b1a9f16` + WORKTREE on
  `~/src/gatherus/custom-fields-to-person-sheet`, hunk
  `@@ -149,34 +150,6 @@` of `packages/backend/db/schema.sql`, marked through a
  throwaway state dir → `hunk_seen = true`.

- Goal: deletions are marked, unmarked and classified through
  `baselines[path].dels`; `Session:wt_seen_sets` composes `baseline.seen_adds`
  with a `covers` view; `apply_wt_seen` writes both halves in one
  `set_baseline`. Legacy records migrate on read as described.
- Tests:
  - `state_test.lua`: `set_baseline` round-trips `dels`; a record with empty
    `lines` and empty `dels` prunes the path (and the worktree slice) so
    mark→unmark is byte-identical; an anchor mismatch hides `dels` as it hides
    `lines`.
  - `baseline`-level (in `state_test.lua` or a session test): a legacy record
    with `lines` and no `dels` yields the same seen sets the old code did, and
    the first mark after it rewrites the record with `dels` present and an
    add-only `lines`.
  - Session-level, on the shape from the bug report (a deletion block whose
    lines are split between a committed owner and WORKTREE, with `--` separators
    repeated inside and after the block): marking the hunk makes
    `Session:hunk_seen` true, and every line's `id_seen` is true. This is the
    regression test for the reported bug — it must fail on `main`.
  - Session-level: the `/tmp/t2.lua` shape — mark every displayed del except
    one, assert every marked line reads seen and the held-out one does not, for
    each choice of held-out line. Fails on `main` for two of the six choices.
  - Unmarking a del restores it to unseen and leaves the file's marked adds
    seen.
- Acceptance: `nvim -l lua/glean/wt_dup_lines_test.lua` passes with 0 failures.
  This is the stage that fixes the reported bug; the stage is not done until it
  does. Then `nvim -l lua/glean/run_tests.lua` passes whole, and the live check
  from the bug report reproduces green: opening base `1b1a9f16` + WORKTREE on
  `~/src/gatherus/custom-fields-to-person-sheet` and marking schema.sql hunk
  `@@ -149,34 +150,6 @@ END;` reports `hunk_seen = true` (run it against a copy
  of the review store, not the live one).

## 3. surfaces and docs

- Goal: the file-buffer marking path (`:Glean toggle-mark` → `M.toggle_mark` →
  `Session:toggle_marks`), the gutter projection and the `api.lua` seen-marking
  entry points all agree with the review buffer on uncommitted deletions.
  `plans/2026-08-28-reviewed-baseline.md` gains a superseding note, and
  `context.md`'s statement of the algebra is corrected to describe the split
  model.
- Tests:
  - `toggle_mark_test.lua`: marking a deleted line from the *file buffer*
    (where a deletion is folded onto a neighbouring row) marks the same head
    line the review buffer would, and the review buffer then renders it seen.
  - `gutter_test.lua`: a deleted-line glyph flips to its seen colour after the
    del is marked, and back on unmark.
  - `api_test.lua`: the paged hunk query reports the marked deletions as seen,
    so an agent driving the API sees the same model as the buffer.
- Acceptance: the full suite passes, `wt_dup_lines_test.lua` included.
