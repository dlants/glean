# Objective and Context

The user's request, verbatim:

> ok, a few things:
>
> - storage should be segregated by repo. All worktrees within the same bare repo (like ~/src/gatherus/) should share the storage.
> - we should anchor the synthetic worktree commit on the branch name, so there should be no bleeding when we move on to a new branch
>
> I'm wondering what we should do about the content-addressing. Having blank lines or "}" match on content file-wide is off... I wonder if we could group content-addressed marks into larger chunks to avoid this?
>
> Let's come up with a plan

## What we're building and why

Today all worktree (uncommitted-change) review state — seen marks and comments
— lives in a single shard whose id is the bare constant `"WORKTREE"`, stored in
one global directory (`stdpath("data")/glean`). Two consequences leak across
boundaries the user does not expect:

1. The store directory is global, not per-repo. Two repos that happen to share a
   `(path, line-text)` can collide.
2. The worktree shard id has no branch component, so switching branches reloads
   the same content-addressed seen/comment set and re-applies it to any
   uncommitted line whose `(path, text)` matches — the "bleeding" the user sees.

Separately, the worktree identity is a single line's `sha256(text)`, so trivial
lines (`}`, blank, common boilerplate) match file-wide and get spuriously marked.

We will (1) segregate storage per repository (shared across that repo's linked
worktrees), (2) anchor the worktree shard on the current branch, and (3) coarsen
content addressing from per-line to per-contiguous-changed-run to kill trivial
collisions.

## Key entities

- `M.WORKTREE = "WORKTREE"` (`init.lua:41`) — plays **two** roles today that
  this plan must split apart:
  - a control-flow **sentinel**: the synthetic floating commit's `sha`, and the
    value compared in `target == M.WORKTREE`, `ref == M.WORKTREE`,
    `commit.sha == M.WORKTREE`. This stays a constant.
  - a **storage shard id**: the key under which content-addressed seen/comments
    persist (`M.COMMENTS_ID = "WORKTREE"` in `state.lua:27`). This must become
    repo+branch specific.
- `Store` (`state.lua`) — keyed by shard id; on disk `<dir>/<id>.json`. Holds
  `seen`/`seen_del` ranges (committed shards) and the content-addressed
  `seen`-hash set + comments (the worktree shard).
- `Git` (`git.lua`) — `repo_root`, `current_branch()`. Needs a new
  `common_dir()` for repo identity.
- Worktree identity: `M.wt_identity(path, text)` → `{ kind="wt", path, text }`,
  routed by `Store:is_seen/mark/unmark` to the worktree shard via the
  hardcoded `M.COMMENTS_ID`.

## Relevant files

- `lua/glean/init.lua` — `build_model` (synthetic commit), session construction
  / `M.open`, the mark-save site (`~1513`/`1530`), render seen-key (`~1842`),
  `resolve_dirty`.
- `lua/glean/state.lua` — `Store.new`, `shard_path`, `load`, the `wt_*` and
  content-addressed comment methods, `wt_identity`, the `is_seen/mark/unmark`
  fold, `hash_adapter`.
- `lua/glean/git.lua` — add `common_dir()`.
- Test suites: `state_test.lua`, `init_test.lua`, `dirty_combined_test.lua`.

# Design

Three independent concerns, each its own stage.

## 1. Per-repo storage directory

Anchor the store directory on the git **common dir** rather than the global
default. `git rev-parse --git-common-dir` returns the shared `.git` that every
linked worktree of a repo points at, so all worktrees of one repo resolve to the
same key while distinct repos diverge. Resolve it to an absolute path (git may
return a relative `.git`).

The store dir becomes `<base>/<repo-key>/` where `<base>` is
`stdpath("data")/glean` and `<repo-key>` is a stable, filesystem-safe digest of
the absolute common dir (e.g. a hash, to avoid path-length / separator issues).
Committed-sha shards (globally unique by sha) are unaffected in correctness by
this move; they simply now live under the repo subdir.

Threading: `Git:common_dir()` exists; `M.open` derives `state_dir` from it when
the caller did not inject one (tests still inject `state_dir`).

## 2. Branch-anchored worktree shard

Split the dual role of `"WORKTREE"`:

- Keep `M.WORKTREE` as the sentinel constant for all control-flow comparisons
  (synthetic commit sha, `target`/`ref` checks). These do **not** change.
- Introduce a per-session **worktree shard id** derived from the current branch,
  e.g. `"WORKTREE/" .. branch`. Store it on the `Store` (`store.wt_shard`, set
  at construction; defaults to `M.COMMENTS_ID` so existing pure-`state` tests
  keep working). Every place inside `state.lua` that currently hardcodes
  `M.COMMENTS_ID` for the worktree/content-addressed shard — `load`,
  `is_seen/mark/unmark` (`kind=="wt"`), `comments_commit`,
  `remove_comment_record`, `comments_for` — routes through `self.wt_shard`.
- `init.lua` sites that name the storage shard explicitly route through the
  store's wt shard instead of the constant: the mark-save `touched` set
  (`~1513`), the comment-save `save_commit` (`~1530`). The render seen-key at
  `~1842` is an in-memory de-dup key, not storage; align it to the wt shard for
  consistency but it is not load-bearing for persistence.

Filesystem: a branch may contain `/` (`feature/foo`). The shard **id** can stay
`"WORKTREE/feature/foo"` in memory, but `shard_path` must map it to a safe
filename (sanitize separators, or digest). Keep id↔filename mapping in one place
(`shard_path`).

Edge cases:
- Detached HEAD: `current_branch()` returns `HEAD`; the shard id falls back to a
  stable label (e.g. `WORKTREE/HEAD` or the short sha). Acceptable; note that
  detached states all share one shard.
- Migration: existing users have a global `stdpath("data")/glean/WORKTREE.json`.
  After this change it is neither in the per-repo dir nor under a branch id, so
  prior worktree marks/comments appear lost. Decision to confirm with the user:
  accept a clean break, or do a one-time best-effort copy of the legacy
  `WORKTREE.json` into the current repo+branch shard on first open. Committed
  shards similarly move under the repo subdir; same decision applies.

## 3. Unify worktree seen-marks with the comment re-anchoring model

The directionality argument is the crux. There are two ways to match
content-addressed state against the current diff:

- **Diff → parts → lookup** (today's seen-marks): flatten the diff, split into
  units (per line, or per maximal run), and test each unit for membership in a
  stored set. This breaks partial marking — if you marked only part of a run and
  the rest changes, the unit derived from the diff no longer equals what you
  stored, so the lookup misses. It also collides file-wide on trivial units.
- **Stored content → search into diff** (today's comments): store the exact
  block the user acted on plus an `anchor` ordinal, then *search* the flattened
  diff for that block, taking the single closest match to the anchor. This is
  what we want.

Scope: this applies **only** to the uncommitted synthetic commit (`kind="wt"`
identities). Committed shards keep their `(sha, lnum)` range addressing — those
post-image line numbers are stable and immutable, so there is no collision and
nothing to re-anchor. Only the worktree commit lacks stable line numbers, which
is the sole reason it needs content addressing at all.

`state.lua` already implements the second direction for comments via
`M.resolve(content, anchor, diff_texts)` (closest contiguous match, distance
tiebreak). The fix is to move **seen-marks onto the same mechanism** instead of
the per-line hash set:

- Marking stores the exact selected contiguous block(s) of changed-line texts
  plus the anchor ordinal (the flattened-diff index at mark time) — the same
  record shape comments use (`{ anchor, content = {...} }`).
- At render, each stored block is re-anchored with `M.resolve` against the
  file's current flattened diff texts; the **single closest match** marks
  exactly those lines seen.

Why this satisfies every case the user described:
- Partial range marked, rest of hunk changes: the stored block's own text is
  unchanged, so `resolve` still finds it contiguously → stays seen.
- Marked content itself changes: the block no longer appears → no match →
  unseen (the accepted coarse behavior).
- Trivial single-line block (`}`/blank): `resolve` returns the *closest* single
  match, so it marks exactly one location, never file-wide. This is the real fix
  for the bleed — not coarser units, but matching exactly one occurrence.

This also collapses two parallel storage schemes (the hash set for seen, the
block records for comments) into one block-record model, addressed identically.

Comments surviving content changes: the machinery already produces an
`outdated` flag (`Session:resolve_comments`/`collect_comments`,
`outdated = start == nil`) and keeps outdated comments in the summary. The
remaining gap is *inline* surfacing — when a comment's content is gone, it is
dropped from the inline view if its stored anchor falls outside the file. To
"still surface the comment, marked out of date": render orphaned comments at a
stable fallback location (clamp the anchor into range, or pin to the file
header) with an outdated highlight, plus an affordance to dismiss/delete them.
Seen-marks need no such treatment — a missing block is simply unseen.

Alternatives considered and rejected:
- Per-line hash (today) — wrong direction; collides file-wide, breaks partial.
- Per-maximal-run chunk hash — still the wrong direction; a partial mark whose
  surrounding run changes loses its mark.
Invariants (all stages):
- `M.WORKTREE` remains the only value used for control-flow identity of the
  synthetic commit; storage-shard identity is a separate, derived value.
- The buffer stays a pure projection: a line "renders as seen" iff the action
  layer's `is_seen` says so — both sides must derive seen lines from the same
  block re-anchoring pass.
- Each stored block marks exactly one (closest) match, never all occurrences.
- Mark→unmark of the same target restores byte-identical shard JSON (existing
  prune invariant) — chunk addressing must preserve it.

# Stages

> Stage 1 status: DONE. `Git:common_dir()` added (resolves
> `git rev-parse --git-common-dir` to an absolute, symlink-normalized path).
> `M.repo_state_dir(git)` derives `<stdpath data>/glean/<sha256(common)[:16]>`,
> and `M.open` uses it for `state_dir` when the caller did not inject one
> (`opts.state_dir or M.repo_state_dir(git)`). Tests: `git_test.lua` covers
> absolute path, worktree-shared, and cross-repo divergence (real worktree via
> `git worktree add`); `init_test.lua` covers `repo_state_dir` stability,
> divergence, base-dir containment, and nil fallback. Full suite green.
> Note: symlink normalization via `vim.fn.resolve` was needed so a linked
> worktree (git emits an absolute `/private/var/...` common dir) and the main
> worktree (relative `.git` anchored under `repo_root` `/var/...`) agree.

## Stage 1 — Per-repo storage directory

- Goal: opening a review in any linked worktree of a repo reads/writes under one
  repo-specific dir; distinct repos use distinct dirs. Committed and worktree
  shards land there.
- Implementation: add `Git:common_dir()` (absolute), derive `state_dir` in
  `M.open` from it when not injected.
- Verification:
  - Behavior: two `Git` handles over the same repo (different worktree paths,
    same common dir) resolve to the same store dir; a different repo resolves
    elsewhere.
    - Setup: fake git runner returning a fixed `--git-common-dir`; or a real
      temp repo + `git worktree add` in an integration test.
    - Actions: construct the store dir from each handle.
    - Expected: equal for same common dir, different across repos.
  - Behavior: existing injected-`state_dir` tests still pass unchanged.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2 — Branch-anchored worktree shard

> Stage 2 status: DONE. `Store.new` now carries `wt_shard` (`opts.wt_shard or
> M.COMMENTS_ID`); every content-addressed (`kind="wt"`) reference in
> `state.lua` — `load`, `is_seen`/`mark`/`unmark`, `comments_commit`,
> `remove_comment_record`, `comments_for` — routes through `self.wt_shard`.
> `shard_path` percent-encodes any char outside `[%w._-]`, so a
> `WORKTREE/feature/foo` id maps to one safe, reversible filename.
> `init.lua`: `M.wt_shard(git)` = `WORKTREE/<current_branch or HEAD>`; `M.open`
> sets it on the store and the session, the two save sites + the render seen-key
> use `store.wt_shard`, and `reload()` reconstructs the store with the session's
> `wt_shard`. Decision: detached HEAD shares a single `WORKTREE/HEAD` shard.
> Also fixed a latent Stage-1 bug — the session stored `opts.state_dir` (nil
> when derived), so a live `reload()` wrote to the global dir; it now stores the
> resolved `state_dir`. Tests: `state_test.lua` adds branch-isolation cases for
> seen-marks (incl. slash-safe filename) and comments; the three init_test
> assertions that probed the hardcoded `WORKTREE` shard now read
> `s.store.wt_shard`. Full suite green.

- Goal: marks/comments on uncommitted lines made on branch A do not appear when
  the same working copy is on branch B; round-tripping within branch A persists.
- Implementation: add `store.wt_shard` (defaulting to `M.COMMENTS_ID`), route
  all worktree/content-addressed shard references in `state.lua` through it,
  make `shard_path` filename-safe, and set `wt_shard` from `current_branch()` in
  `M.open`. Update the two init save sites to use the store's wt shard.
- Verification:
  - Behavior: same `(path, text)` uncommitted line is seen on branch A, unseen
    after switching the shard id to branch B.
    - Setup: store with `wt_shard="WORKTREE/a"`, mark a wt identity, save; reload
      with `wt_shard="WORKTREE/b"`.
    - Actions: `is_seen` the same identity under each shard.
    - Expected: seen under A, unseen under B; A's shard file untouched by B.
  - Behavior: branch names with `/` produce a valid single shard file.
  - Behavior: comments exhibit the same branch isolation
    (`add_comment_record`/`comments_for`).
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3 — Block-based worktree seen-marks + orphaned-comment surfacing

- Goal: partial marks survive unrelated edits in the same hunk; a marked block
  whose own text changes goes unseen; a trivial single-line mark (`}`/blank)
  marks exactly one location, never file-wide; orphaned comments stay visible,
  flagged out of date.
- Implementation: replace the worktree seen hash set with block records
  (`{ anchor, content = {...} }`) per path, re-anchored at render via
  `M.resolve` (closest match) — the same model comments use. Marking captures
  the selected contiguous block(s) and the anchor ordinal; `is_seen` is derived
  from the per-render re-anchor pass. Remove `is_seen_hash`/`mark_seen_hashes`
  in favor of the unified block store. Add a fallback render location +
  outdated highlight for comments whose content is gone (clamp anchor into
  range / pin to file header) with a dismiss affordance. Preserve the
  mark→unmark byte-identity invariant via record-matched removal.
- Verification:
  - Behavior: two hunks each with a standalone `}` changed line — marking one
    marks exactly that one, the other stays unseen.
  - Behavior: mark the first two lines of a 4-line change; edit the last two
    lines; the first two stay seen.
  - Behavior: mark a block, then edit a line inside it — it becomes unseen.
  - Behavior: a comment whose content leaves the diff still renders, flagged
    outdated, and can be dismissed.
  - Behavior: mark then unmark a block yields byte-identical shard JSON.
- Before moving on: confirm tests, type checks, and linting all pass.

# Open decisions for the user

- Stage 1/2 use a clean break (no migration): the legacy global
  `WORKTREE.json` and the global committed shards are simply not read from the
  new per-repo dir. Confirmed by the user.
- Detached HEAD: confirm the fallback shard label (e.g. `WORKTREE/HEAD` vs.
  short sha) — all detached states would share one shard under the former.
- Orphaned-comment placement: clamp the anchor into range vs. pin to the file
  header. Either way it renders with an outdated highlight and a dismiss key.
