# Objective and Context

User's request (verbatim):

> I'm not super happy with how glean behaves when I revisit previously reviewed
> code, like when I provide a review, and the agent follows up.
>
> So we currently store seen status line by line on committed code. When the code
> changes I end up seeing these diffs where there's a lot of changing between seen
> and not seen lines. A single hunk can get a lot of lines that are technically
> seen but are just scattered through a change section.
>
> I think what I'd like to do is look into how I can improve this. I don't think I
> wanna mess with the way that things are stored because that pattern is pretty
> straightforward, right? We have a commit, we have a line number, and we know
> that the user looked at it. I think when we're displaying diffs that have
> previously been reviewed, we should have some sort of threshold for unmarking
> lines as seen or displaying them as unseen. That way we don't get this scattered
> seen-not-seen display because it's just very confusing and I have to go in and
> unmark each line, which is really annoying.
>
> take a look at this and see how we can set it up - is there a way we can modify
> the way we display combined hunks? I'm thinking something like "minimum seen
> marked range" - so if a seen range from a previous commit is less than, say, 5
> lines, and is adjacent to stuff that's changed more recently and is not seen,
> then we just show it as unseen. Make sure it still works with manually marking
> visual ranges as seen - so if we explicitly mark a single old line as seen in
> *the current context* then it should stay marked

## What we're building

A **display-only** transformation over combined-scope hunks: short seen runs
that are interleaved with newer unseen changes are rendered as *unseen* diff
lines instead of as collapsed `✓ marked N lines` markers. The persisted store is
untouched — the (sha, lnum) seen model stays exactly as-is. This is a projection
tweak, consistent with the core invariant "model is the source of truth, the
buffer is a pure projection".

The one wrinkle: a user must be able to override the demotion by explicitly
marking lines seen in the current session, and have that stick. Since the store
already records those lines as seen (so re-marking is a store no-op), we need a
session-only "sticky" set that exempts explicitly-marked identities from
demotion for the life of the session (matching "in *the current context*").

## Key entities

- `hunk_marker_runs(hunk, is_seen)` (init.lua ~218) — pure; returns the maximal
  contiguous runs of seen changed lines in a hunk. The seam where we demote.
- `emit_hunk` (init.lua ~948) — renders a hunk; calls `hunk_marker_runs` for the
  unseen section (seen section passes `{}`). Turns each run into a collapsed
  marker; non-run changed lines render as ordinary add/del rows.
- `Session:hunk_seen` / `id_seen` (init.lua ~573, ~596) — store-backed seen
  predicates deciding *section placement* (seen vs unseen). Left unchanged.
- `Session:mark_visual_range` (~2263) and `Session:toggle_seen` (~2079) — the two
  explicit user mark paths that must feed the sticky set.
- `M.config` (~47), `M.open` opts, `Session` construction (~3029) — where the
  threshold is configured and stored.

## Relevant files

- `lua/glean/init.lua` — all render + action logic; the whole change lives here.
- `lua/glean/init_test.lua` — session/render integration tests (fake git runner).
- `lua/glean/dirty_combined_test.lua` — combined-scope render tests; good model
  to follow for a fixture exercising interleaved seen/unseen lines.

# Design

Add a threshold `min_seen_run` (config default 5; 0/1 disables). At render time,
in **combined scope only**, a seen run inside a *partially-seen* hunk (i.e. a
hunk in the unseen section — it necessarily has unseen changed lines adjacent)
is **demoted** to plain unseen rows when:

- its length `n < min_seen_run`, AND
- not every identity in the run is in the session sticky set.

Demotion works over a per-line `display_seen[i]` predicate rather than by
dropping whole runs, because stickiness is per-line and can survive inside an
otherwise-demoted run:

1. Compute the raw seen runs from the store (`hunk_marker_runs` with the
   store-backed `is_seen`).
2. For each run, if its length `>= threshold`, mark all its lines
   `display_seen = true`. If its length `< threshold`, mark only its **sticky**
   lines `display_seen = true` and demote the rest.
3. Re-derive marker runs by feeding `display_seen` back into `hunk_marker_runs`.
   Demoted lines fall through `emit_hunk`'s `else` branch and render as ordinary
   `+`/`-` rows (unseen highlight), naturally rejoining intra-line pairing; a
   surviving sticky line forms its own (possibly single-line) marker.

No other code path changes because `hunk_seen`/`id_seen` (section placement,
header glyphs, rollups) still read the store, so counts stay truthful -- we only
change how a partially-seen hunk *looks inside*.

Factor the pass-2 computation into a pure helper, e.g.
`display_seen_map(runs, threshold, is_sticky)`, so it is headless-testable and
the run-detection logic stays untouched.

## Stickiness is content-addressed, not session-scoped

Stickiness attaches to the **combined hunk content**, not to the session. A
sticky record is keyed by line content (path + `state.line_hash(text)` -- the
same content-hash the worktree identity already uses), so:

- it applies to that line wherever its content appears, across renders/reopens;
- it **self-invalidates when the code changes**: once the agent rewrites a line,
  its content hash no longer matches, so the mark stops being sticky and the run
  demotes again -- exactly the "revisit previously reviewed code" behavior the
  user wants;
- it is granular enough to honor "explicitly mark a *single old line* as seen".

Store the sticky set as a new content-addressed record set persisted alongside
the review store, parallel to how comments already live content-addressed in the
`WORKTREE`/`COMMENTS_ID` shard. This does **not** touch the seen `(sha, lnum)`
model the user asked to leave alone; it is a sibling set living in the same
always-loaded `WORKTREE`/`COMMENTS_ID` shard, so it is global per
(repo, path, content) rather than tied to a base..target range. (An in-memory
`views[key]` table like collapse overrides was rejected: it is lost on nvim
restart, which would undermine cross-session revisits.)

`is_sticky(dl)` = "this changed line's content key is in the sticky set". It is
populated in `mark_visual_range` and `toggle_seen` for every line the user
marks -- *including lines already seen in the store* (the override case), so
those paths must record stickiness even when they produce no seen-store mutation,
and must still re-render.
Why combined-scope only: the request is about combined hunks mixing an older
seen commit with newer unseen changes. In commits scope a partially-seen hunk
means the user deliberately marked part of a single commit's hunk; demoting
there would fight the user. Gate on `self.scope == "combined"`.

Invariants:
- The persisted store is byte-for-byte unaffected by this feature; mark/unmark
  round-trip identity still holds.
- Section placement and all header/rollup counts remain store-derived and thus
  unchanged; only within-hunk marker rendering differs.
- A fully-seen hunk (seen section) is never demoted — it has no unseen neighbors,
  and the seen section already passes `{}` runs.
- A large contiguous seen run (`n >= threshold`) still collapses to a marker.
- Demoting then re-marking a line (explicit `m`) records a content-addressed
  sticky mark, so the line renders seen again -- across renders and reopens --
  without any seen-store change.
- A sticky mark self-invalidates when the line's content changes (its content
  hash stops matching), so rewritten code re-demotes.
- `threshold <= 1` disables demotion entirely (back to current behavior).

Edge cases to handle:
- Stickiness is per-line, so a short run can partly survive: within a demoted
  run, sticky lines stay seen (each as its own marker) while the rest demote.
- Worktree/uncommitted lines are already content-hashed; the sticky content key
  reuses `state.line_hash(text)` under the path, so it is uniform across
  committed and uncommitted lines.

# Stages

## Stage 1 — Threshold plumbing + pure display-seen helper

**Status: DONE.** `min_seen_run` added to `M.config` (default 5) and plumbed
onto the session via `opts.min_seen_run or M.config.min_seen_run`. Pure
`display_seen_map(runs, threshold, is_sticky)` added after `hunk_marker_runs`
and exported via `M._internal`. Unit tests cover long/short/partly-sticky/
disabled/boundary cases in `init_test.lua`. Full suite green (`run_tests.lua`);
no luacheck configured in repo.

- Goal: `min_seen_run` flows from `M.config`/`M.open` opts onto the session; a
  pure `display_seen_map(runs, threshold, is_sticky)` exists and is exported for
  tests. Not yet wired into rendering.
- Verification:
  - Behavior: lines in a run of length `>= threshold` stay display-seen; in a
    short run only sticky lines stay display-seen, the rest demote; `threshold
    <= 1` keeps every seen line.
  - Setup: hand-built run descriptor lists (no session needed) + a stub
    `is_sticky` over line indices.
  - Actions: call `display_seen_map` directly.
  - Expected outcome: the returned per-line map matches expectation across the
    short/long/partly-sticky/disabled cases.
- Before moving on: confirm tests, type checks (`luacheck` if configured), and
  the full suite pass.

## Stage 2 — Wire demotion into combined-scope rendering

**Status: DONE.** `emit_hunk` now, in combined scope's non-seen section, feeds
its store-derived runs through `display_seen_map(self.min_seen_run)` and
re-derives marker runs from the resulting per-line predicate (sticky arg left
`nil` until Stage 3). Short seen runs render as plain unseen `+/-` rows; runs
`>= threshold` still collapse. Section placement/counts untouched. The
pre-existing "combined marker" test (a 2-line marker) now passes
`min_seen_run = 1` to keep testing marker routing with demotion disabled; a new
render test covers demote (short run, no marker), collapse (6-line marker), and
the disabled (threshold 1) case. Full suite green.

- Goal: `emit_hunk` (combined scope, unseen section) feeds its raw runs through
  `display_seen_map` and re-derives markers from the resulting predicate; short
  non-sticky runs now render as ordinary unseen rows. Commits scope and the seen
  section are unaffected.
- Verification:
  - Behavior: a combined hunk with a scattered 2-line seen run interleaved with
    unseen changes renders those 2 lines as plain `+/-` rows (no `✓ marked`
    marker); a 6-line seen run still renders as a collapsed marker.
  - Setup: a combined-scope session (fake git runner) with a file whose blame
    attributes some lines to an older commit marked seen and others to a newer
    commit left unseen — model on `dirty_combined_test.lua`.
  - Actions: build + render; inspect emitted rows / row_map.
  - Expected outcome: no marker row for the short run; marker row present for the
    long run; section counts and header glyphs unchanged.
- Before moving on: confirm the full suite, type checks, and linting pass.

## Stage 3 — Content-addressed sticky override on explicit marks

- Goal: a persisted, content-addressed sticky set (parallel to comments) exists;
  `mark_visual_range` and `toggle_seen` record a sticky mark for every line the
  user marks (even already-store-seen ones) and re-render; a demoted line
  re-marked by the user renders seen again, persisting across reopen and
  self-invalidating when its content changes.
- Verification:
  - Behavior 1: after a short run is demoted, marking those lines renders them
    seen and they stay seen on subsequent renders and on reopen of the session.
  - Behavior 2: marking already-store-seen demoted lines produces no seen-store
    mutation but still records stickiness and re-renders (the existing
    early-return on an empty seen-id list must not skip the sticky record /
    render).
  - Behavior 3: after a sticky line's text changes (edit the fixture's diff
    content), it re-demotes because the content hash no longer matches.
  - Setup: the Stage 2 combined fixture; drive `mark_visual_range` over the
    demoted rows; then a second session reload / a content edit.
  - Actions: render → mark_visual_range → render; reopen → render; edit content →
    render.
  - Expected outcome: rows reflect sticky-seen after marking and after reopen;
    seen-store JSON unchanged by the already-seen case; content change re-demotes.
- Before moving on: confirm the full suite, type checks, and linting pass.

## Stage 4 — Docs

- Goal: document `min_seen_run` in `README.md` (user-facing) and note the
  display-demote + content-addressed sticky behavior in `context.md`'s
  architecture notes.
- Verification: prose only; ensure the suite still passes.
