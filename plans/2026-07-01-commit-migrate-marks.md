# Objective and Context

User's request, verbatim:

> So when I review something that is not committed, we store those marks and
> comments currently by their content address. When they move into commit, I
> would like to convert them to be associated with that commit.
>
> I think we should be watching the git state. When we see that the git state
> transitions and we have a new commit on top for a branch that has a synthetic
> work tree commit, we should look at the files that were committed (the
> committed versions) and see if we have exact matches on the content. If there
> is an exact match on the content, we should transfer those from the synthetic
> work tree commit to the actual commit in storage. Basically monitor git,
> detect new commits when they're committed, and then for those comments and
> marked or visible markers that have exact content matches, let's add those
> lines into storage.

## What we're building

A live glean review already polls the repo (`Session:start_live` / `dirty_sig`)
and re-renders on any change. Right now, when dirty content that was already
reviewed gets committed, the review state doesn't carry over cleanly:

- **Seen marks** on uncommitted lines are stored as content-block records in
  the always-loaded `WORKTREE` shard (`Store:seen_records`/`add_seen_record`),
  re-anchored at render time by `M.resolve` against whatever file is currently
  displayed (`Session:wt_seen_ords`). Once a line is committed, its owner
  (`Session:commit_owner`/`combined_owner`) resolves to the real commit sha
  instead of `M.WORKTREE`, so seen-ness for that line is looked up via
  `Store:is_seen` against the commit's **range-based** `seen`/`seen_del`
  storage — which has no entry for it. The mark is effectively lost even
  though the content is byte-identical.
- **Comments** are stored globally, content-addressed, independent of commit
  (`Store:add_comment_record`/`comments_for`, always resolved by `M.resolve`
  against whichever file is currently rendered at that path). This means a
  comment on a since-committed line *does* keep rendering today — but it stays
  keyed to raw content forever, in a shard that is always loaded regardless of
  which commits a review spans, growing without bound and reusable by
  coincidental identical content anywhere else in the repo.

We'll make both kinds of record migrate deterministically off content
addressing and onto the immutable `(sha, path, lnum)` identity as soon as a
git-observed commit lands with matching content, so review state properly
"settles" the moment its content is committed, and the `WORKTREE` shard stops
accumulating state for lines that no longer need content addressing.

## Key entities

- `Session` (`lua/glean/init.lua`) — one open live review buffer. Holds
  `self.store`, `self.commits`, `self.base`/`self.target` (`M.WORKTREE` for a
  live review), and drives the poll loop (`start_live`/`stop_live`/`reload`,
  around init.lua:2768-2825).
- `Store` (`lua/glean/state.lua`) — the persisted, sha-sharded review store.
  - `seen_records`/`add_seen_record`/`set_seen_records`: WORKTREE-shard content
    block records `{ anchor, content = {texts} }` for uncommitted seen marks.
  - `comments_for`/`add_comment_record`/`remove_comment_record`: WORKTREE-shard
    content block records `{ anchor, content = {texts}, text }`, global per path.
  - `mark_seen`/`mark_seen_del`/`seen_ranges`/`seen_del_ranges`: per-commit
    range-based seen storage (the canonical committed representation).
  - `add_comment`/`comments_at`/`remove_comment`: an existing but currently
    **unwired** per-commit, per-`new_lnum` comment store — no del-line
    equivalent exists yet.
  - `M.resolve(content, anchor, diff_texts)`: pure "closest exact contiguous
    match" resolver already used for re-anchoring; we reuse it unchanged to
    resolve WORKTREE records against a *committed* diff's line-text sequence
    instead of the live worktree diff.
- `Git` (`lua/glean/git.lua`) — `rev_parse`, `commits(base,target)`,
  `commit_diff(sha)`, `dirty_sig()`. No ancestor-check helper exists yet
  (`merge-base --is-ancestor`) — needed to safely distinguish a fast-forward
  commit from an amend/rebase/checkout.
- `diff.lua` — `DiffLine { kind, text, old_lnum, new_lnum }`: add lines carry
  `new_lnum`, del lines carry `old_lnum` (pre-image), matching `add_identity`/
  `del_identity` exactly.

# Design

## Detecting a commit transition

`Session:start_live` already ticks on a timer and calls `Session:reload()`
whenever `Git:dirty_sig()` changes (init.lua:2804-2825). `dirty_sig` folds in
`HEAD`, so both "new commit" and "plain edit" changes trigger a reload; we need
to tell them apart. Track the last-seen `HEAD` sha on the session (`self._head`,
alongside the existing `self._sig`). On each `reload`:

1. Resolve `new_head = self.git:rev_parse("HEAD")`.
2. If `self._head` is set and `new_head ~= self._head`, and
   `self._head` is an ancestor of `new_head` (new `Git:is_ancestor` helper
   wrapping `git merge-base --is-ancestor`), the commits in
   `self._head..new_head` (`self.git:commits(self._head, new_head)`, oldest
   first) are newly-landed commits to migrate against.
3. If `new_head ~= self._head` but it is *not* an ancestor (amend, rebase,
   branch switch, reset), skip migration for this tick — we can't safely
   assume any prior identity still applies — but still advance `self._head`.
4. Update `self._head = new_head` unconditionally at the end of `reload`.

This only runs for live (`self.worktree`) sessions, since only they poll and
only they own a `WORKTREE`-addressed dirty file whose lines are migration
candidates.

## Migrating content-addressed records onto a landed commit

For each newly-landed commit sha (in order), and for each file it touched
(`self.git:commit_diff(sha)`, reusable via the existing `_commit_files` cache
so we don't double the subprocess cost against `build_model`):

1. Build that file's ordered *changed-line* sequence — add/del lines only, in
   the same ordinal convention `Session:changed_lines`/`line_identity` already
   use — as parallel arrays of `text` and `(kind, lnum)` (add → `new_lnum`,
   del → `old_lnum`).
2. Against the **pre-reload** store (capture `local old_store = self.store`
   before `Session:reload` builds the fresh one), for that path, take every
   `old_store:seen_records(path)` block and every `old_store:comments_for(path)`
   record and resolve it with `M.resolve(record.content, record.anchor,
   changed_texts)`.
3. A resolved match at ordinal `start` spans `start .. start + #content - 1`
   in the changed-line sequence, i.e. a known contiguous run of `(kind, lnum)`
   pairs. Translate that into:
   - seen-mark record → `store:mark_seen`/`mark_seen_del` range(s) on the new
     commit's shard (contiguous runs of the same kind coalesce automatically
     via `M.add`).
   - comment record → one call per line into the new per-commit comment store
     (`Store:add_comment` for add lines; a new parallel `Store:add_comment_del`
     for del lines — see below), carrying the same `text`.
4. Remove the migrated record from the `WORKTREE` shard (`set_seen_records`/
   `remove_comment_record`) so it isn't retained twice.
5. Persist: write the new commit's shard first, then the pruned `WORKTREE`
   shard, so a mid-way failure only risks a harmless duplicate rather than
   silently dropping review state.

A record that fails to resolve (content changed before commit — e.g. the user
edited after marking, or the commit is a squash/amend of something else) is
left untouched in `WORKTREE`; nothing is lost, it simply keeps working exactly
as it does today (content re-anchoring against whatever is currently
displayed).

Because each commit's diff is resolved against *its own parent*, landing two
commits in one tick (e.g. `git commit` twice while glean was unfocused) still
migrates correctly in sequence: a line introduced by the second commit cannot
spuriously match while resolving the first.

## Extending comments to a per-commit identity

Comments currently have no del-line, per-commit storage — only the unwired,
add-only `Store:add_comment`/`comments_at`. Add symmetrical del-line methods
(`add_comment_del`/`comments_at_del`/`remove_comment_del`) mirroring
`mark_seen_del`/`seen_del_ranges`, storing under a `comments_del` map keyed by
pre-image lnum the same way `seen_del` parallels `seen`.

Rendering must then union two sources per path: the existing global
content-addressed `comments_for(path)` (still authoritative for anything not
yet migrated, and for comments authored directly against historical commits)
and any per-commit `comments_at`/`comments_at_del` entries for the shas backing
the currently displayed lines. `Session:resolve_comments`/`collect_comments`
(init.lua:783-839) gain this second lookup, keyed by each line's resolved
`(sha, lnum)` identity (already computed for seen-ness via `owner`/
`line_identity`), so a migrated comment renders exactly where it did before —
now anchored, not content-matched, so it can never drift or collide.

## Invariants

- Migration only ever *adds* to a commit shard and *removes* from `WORKTREE`
  on an **exact, resolved** content match — never guesses, never fabricates a
  location, and never touches unrelated files/commits.
- No migration on non-ancestor `HEAD` changes (amend/rebase/checkout/reset):
  guarded by the ancestor check.
- No migration on the very first load of a session (`self._head` unset) — there
  is no prior transition to observe yet.
- Idempotent: once a record is removed from `WORKTREE`, a later poll tick has
  nothing left to (re-)migrate for it, even if `reload` runs again before the
  next real commit.
- A record that doesn't resolve is left exactly as-is; existing content-address
  rendering behavior is the fallback, never a regression.

# Stages

## 1. `Git:is_ancestor` + HEAD-transition tracking in `Session`

- Goal: `Session` can tell, on each live poll, whether `HEAD` advanced by a
  plain fast-forward commit (vs. an amend/rebase/checkout), and can list the
  newly-landed commits, without yet doing anything with that information.
- Verification (in `git_test.lua` / `init_test.lua`, injected fake runner):
  - Behavior: `is_ancestor` reports true for a real ancestor, false otherwise.
    - Setup: fake `run` stubbing `merge-base --is-ancestor` exit codes.
    - Actions: call `Git:is_ancestor(a, b)` for an ancestor and a non-ancestor pair.
    - Expected outcome: true / false respectively.
  - Behavior: a `Session:reload()` tick after a plain new commit computes the
    correct `{old_head..new_head}` commit list; a tick after a non-ancestor
    `HEAD` change computes none.
    - Setup: fake git runner scripted to return successive `rev-parse HEAD`
      values and canned `commits`/`merge-base --is-ancestor` results.
    - Actions: call `reload()` twice with different injected HEAD values.
    - Expected outcome: the tracked pending-migration commit list matches
      expectations for both the ancestor and non-ancestor case.
- Before moving on: confirm tests, type checks, and linting all pass.

## 2. Pure seen-mark migration resolver in `state.lua`

- Goal: a pure, headlessly-testable function that, given a `WORKTREE` shard's
  seen-mark/comment records for a path and a target commit's changed-line
  `(kind, lnum, text)` sequence, returns which records resolve and where they
  land — with no git or Session dependency.
- Verification (`state_test.lua`):
  - Behavior: an exact single-line content match on an add line resolves to
    that line's `new_lnum`.
    - Setup: one seen-mark record `{anchor=N, content={"foo"}}`; changed-line
      sequence `[{kind="add", lnum=5, text="foo"}]`.
    - Actions: run the resolver.
    - Expected outcome: resolves to `add_identity` range `{5,5}`.
  - Behavior: a multi-line contiguous block resolves to a contiguous lnum run
    spanning mixed add/del kinds correctly (add run vs. del run split).
  - Behavior: no match (content changed) leaves the record untouched and
    reports no migration.
  - Behavior: duplicate content elsewhere in the file doesn't spuriously
    migrate a record anchored far away (anchor tie-break, already covered by
    existing `M.resolve` tests — confirm behavior carries through unchanged).
- Before moving on: confirm tests, type checks, and linting all pass.

## 3. Del-line per-commit comment storage

- Goal: `Store` gains `add_comment_del`/`comments_at_del`/`remove_comment_del`,
  symmetric with the existing add-line `add_comment`/`comments_at`/
  `remove_comment`, storing under `comments_del` keyed by pre-image lnum.
- Verification (`state_test.lua`):
  - Behavior: round-trip add/read/remove of a del-line comment survives a
    save/reload cycle, independent of the existing add-line comment map.
- Before moving on: confirm tests, type checks, and linting all pass.

## 4. Wire migration into `Session:reload`

- Goal: on a detected commit transition (Stage 1), each newly-landed commit's
  touched files are checked against the pre-reload `WORKTREE` shard using the
  Stage 2 resolver; resolved seen-marks and comments are written into the new
  commit's shard (using Stage 3's del-comment methods where needed) and pruned
  from `WORKTREE`, with the commit shard persisted before the pruned
  `WORKTREE` shard.
- Verification (`init_test.lua`, fake git runner + real `Store` against a temp
  dir):
  - Behavior: a seen-marked uncommitted line that gets committed unchanged
    shows as seen under the new commit on the next render, and is gone from
    the `WORKTREE` shard on disk.
    - Setup: seed a `Store` with a `WORKTREE` seen-mark record for a path;
      script the fake git runner so `worktree_diff`/`diff_to_worktree` initially
      show the dirty line, then a later poll's `rev-parse HEAD` advances and
      `commit_diff` returns that same line as a committed add.
    - Actions: `start_live`-style two ticks (or direct `reload()` calls) driving
      the transition.
    - Expected outcome: `store:seen_ranges(new_sha, path)` covers the migrated
      lnum; `store:seen_records(path)` (WORKTREE) no longer contains it.
  - Behavior: same for a comment (add-line and del-line cases), landing in the
    new commit's per-commit comment store and still rendering at the right row.
  - Behavior: an amend (non-ancestor `HEAD` change) leaves all `WORKTREE`
    records untouched.
  - Behavior: content edited between marking and committing (no exact match)
    leaves the record in `WORKTREE`, unmigrated, still rendering via today's
    content-address fallback.
- Before moving on: confirm tests, type checks, and linting all pass.

## 5. Comment rendering union (per-commit + global)

- Goal: `Session:resolve_comments`/`collect_comments` read both the global
  content-addressed `comments_for(path)` and the per-commit `comments_at`/
  `comments_at_del` for the sha(s) owning the currently displayed lines, so a
  migrated comment (Stage 4) renders identically to before migration, and a
  comment authored directly against a historical commit (not through the
  worktree) also has a path to per-commit storage if desired later.
- Verification:
  - Behavior: a migrated comment renders at the same row/text as it did before
    migration, in both `commits` and `combined` scope.
    - Setup: drive the Stage 4 migration test through to a render, in both
      scopes.
    - Actions: inspect the rendered buffer's comment virtual text / `row_map`
      comment entries at the expected row.
    - Expected outcome: identical rendered comment content pre- and
      post-migration.
- Before moving on: confirm tests, type checks, and linting all pass.
