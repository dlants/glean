# Objective and Context

> the main issue I have with glean is the speed. Loading a large diff is quite slow still...
> I think the main source of slowness is that we do many git commands while loading a diff.
> [...] is there a programmatic api for git that we could reach for here [...] are we dealing with
> structured data right now? The expensive queries we're running - what are they actually telling us
> about the code?
>
> ok, write up a complete plan for how this will work

## What the expensive queries are

Opening a combined-scope review currently costs **two subprocesses per displayed file**:

- `Session:load_owner_async` → `git blame -p <target> -L...` per path, parsed by
  `provenance.parse_blame` into `prov: new_lnum -> { sha, orig_lnum }`.
- `Session:del_attribution_async` → `git blame -p --reverse <base>..<end>` per path
  (skipped for add-only files), turned by `build_del_map` into
  `del_attr: old_lnum -> { sha, lnum }`.

Measured on this repo's full history (30 commits, 20 files): ~0.35s for the forward blames and
~0.35s for the reverse blames, versus **0.04s** for a single
`git log --first-parent -p -U0 -M <base>..<target>`. Blame is O(files x history depth); the log walk
is O(total patch bytes) and shares all tree traversal across files.

There is no programmatic API that helps: git's object store holds only snapshots (commit -> tree ->
blob). No per-line lineage is recorded anywhere; blame *derives* it by re-diffing at query time, and
libgit2's `git_blame` runs the identical computation. The win is algorithmic — ask a smaller
question — not in how we talk to git.

The smaller question: **for each changed line in the net `base..target` diff, which commit in the
range wrote or removed it, and what that line's number is in that commit's blob** — the post-image
blob for an added line, the pre-image (parent's) blob for a removed one. Those are the coordinates
the ReviewStore is keyed by, and they are stable because a commit's blobs are immutable. A commit's
patch reports both directly as `new_lnum` / `old_lnum`, so the ordered patches of the commits in the
range answer this completely and exactly once.

## Key entities

- `Session._owner[path] = { status, prov, del_attr }` — the per-path ownership cache
  (`init.lua:371-429`). `Session:combined_owner(path)` closes over it and is the *only* consumer:
  del lines look up `del_attr[dl.old_lnum]`, everything else `prov[dl.new_lnum]`.
- `Session:line_identity` (`init.lua:650`) turns `(sha, lnum)` from an owner closure into a store
  identity: `add_identity(sha, path, lnum)` for adds, `del_identity(sha, path, lnum)` for dels,
  `wt_identity` for `M.WORKTREE`.
- `Session:commit_owner(commit)` (`init.lua:360`) — the commit-scope counterpart, returning
  `(commit.sha, dl.new_lnum or dl.old_lnum)`. **Combined ownership must agree with this**; that
  agreement is what makes a mark in one scope visible in the other.
- `diff.parse(text)` (`diff.lua`) — unified text -> ordered FileEntries
  `{ path, old_path, kind, hunks }`, hunks `{ old_start, old_count, new_start, new_count, lines }`,
  lines `{ kind, text, old_lnum, new_lnum }`.
- `Git:run` / `Git:run_async` (`git.lua:38,59`) — the injectable runner every git call goes through.

## Files

- `lua/glean/lineage.lua` — **new**. Pure patch-composition: ordered patches -> `prov` / `del_attr`.
- `lua/glean/lineage_test.lua` — **new**. Unit tests plus a blame-oracle equivalence test.
- `lua/glean/git.lua` — add `log_patches` / `log_patches_async`; make `Git:commits` first-parent and
  retire `commit_diff`.
- `lua/glean/init.lua` — replace the per-file blame loader with a single lineage load.
- `lua/glean/provenance.lua` — **deleted**, along with `provenance_test.lua`, once the blame path is
  gone. Its `parse_blame` survives temporarily inside `lineage_test.lua` as the equivalence oracle.

# Design

## The query

```sh
git log --first-parent --reverse -p -U0 -M --no-color --format=%x00%H%x09%s <base>..<target>
```

- `--first-parent` — a linear chain of parent->child patches (see Merges below). Composition is
  undefined without it: sibling patches are both expressed in the base's coordinates.
- `--reverse` — oldest first, which is both the order the walk needs and the order
  `Git:commits` already returns.
- `-p -U0` — the patch for each commit against its (first) parent, with zero context lines. `-U0`
  shrinks the output and, more importantly, makes every hunk a single contiguous change block:
  all deletions then all additions, no interleaving. One hunk becomes one splice.
- `-M` — rename detection, so a rename is one entry with `old_path ~= path` rather than a
  delete plus an add. The walk needs this to carry a file's accumulated origins across a rename.
- `--format=%x00%H%x09%s` — a NUL byte, the full sha, a TAB, the subject. The NUL is a sentinel we
  split the whole output on; it cannot occur in the patch text because git never emits binary
  content in a text diff (it prints `Binary files ... differ`).

Real output for a three-commit range (prepend a line; rename + edit + drop a line; an empty
commit), with `^@` for NUL:

```
^@3b0bb5d...	c1 prepend zero
diff --git a/f.txt b/f.txt
@@ -0,0 +1 @@
+zero
^@c00d912...	c2 rename + edit + drop four
diff --git a/f.txt b/g.txt
rename from f.txt
rename to g.txt
@@ -3 +3 @@ one
-two
+TWO
@@ -5 +4,0 @@ three
-four
^@11b038d...	c3 empty
```

`Git:log_patches` splits on NUL (dropping the leading empty chunk), takes the sha and subject off
the first line of each chunk, and feeds the remainder to the existing `diff.parse`. The result is
the ordered `{ sha, summary, files }` list — the commit list, every commit's diff, and the
composition input, from one process. An empty commit yields an entry with `files = {}`.

## Reading the commit-blob line number off a hunk

`diff.parse` already assigns each DiffLine the number it carries in the commit's blobs: an `add`
line's `new_lnum` counts up from `new_start` through the commit's post-image, a `del` line's
`old_lnum` counts up from `old_start` through the pre-image. So for commit `C`:

- `+TWO` at `new_lnum = 3` is line 3 of `C`'s `g.txt` -> origin `{ sha = C, lnum = 3 }`, which is
  exactly the identity commit scope mints via `commit_owner` (`add_identity(C, path, 3)`).
- `-four` at `old_lnum = 5` is line 5 of `C`'s *parent's* `f.txt` -> if that line's current origin
  is `{ base = B }`, record `del_attr[B] = { sha = C, lnum = 5 }`, matching
  `del_identity(C, path, 5)`.

No arithmetic beyond what the parser already does — the numbers are read straight off the lines.

The one place the header matters is *where in the current image to splice*. With `-U0`:

- If the hunk has deletions, the splice starts at the first del line's `old_lnum` and covers
  `old_count` lines. (`@@ -3 +3 @@` -> replace 1 line at position 3.)
- If it is a pure insertion, `old_count` is 0 and `old_start` is the line the insertion goes
  *after*, so the splice is a zero-width insert at `old_start + 1`. (`@@ -0,0 +1 @@` -> insert at
  position 1; `@@ -7,0 +8 @@` -> insert at position 8.)

Positions here are in the coordinates of the image built so far — i.e. `C`'s pre-image, which is
what the previous patches produced — so the hunk's `old_*` numbers line up with the running state
by construction, and the `new_*` numbers are only ever used as the origin's `lnum`.

## The composition walk

Walk the range's patches oldest-first, maintaining for each path a model of "the file as it stands
after the patches applied so far", where every line carries its **origin**:

- `{ base = B }` — a line inherited from the base image, at base line number `B`.
- `{ sha = C, lnum = L }` — a line introduced by in-range commit `C`, at line `L` in `C`'s
  post-image (i.e. exactly the `new_lnum` commit scope addresses it by).

Applying one patch to one path, per hunk (with `-U0` every hunk is a contiguous change block: all
`old_count` deletions first, then all `new_count` additions — verified against git):

- The `old_count` lines at the hunk's pre-image position are removed. For each removed line whose
  origin is `{ base = B }`, record `del_attr[B] = { sha = C, lnum = old_start + i - 1 }` — the
  deleter and the line's number in the deleter's pre-image, which is precisely what reverse blame
  reconstructs today. Removed lines with an in-range origin are dropped silently: they were added
  and deleted inside the range, so they never appear in the net diff.
- `new_count` lines with origin `{ sha = C, lnum = new_start + j - 1 }` are inserted in their place.

After the last patch, the surviving lines' positions are the net diff's `new_lnum` coordinates, so
`prov[position] = origin` for every in-range origin. Base-origin survivors get no `prov` entry;
those are exactly the net diff's context lines, which `line_identity` returns nil for anyway.

**Both maps fall out of the same pass.** Reverse blame disappears entirely.

## Representation

A per-path array of one entry per line is O(file size) and needs the file's length (an extra
`cat-file`). Instead each path holds an ordered list of **segments**, each covering a run of
consecutive lines:

- `{ base = B, n = k }` — `k` lines inherited from base starting at base line `B`.
- `{ sha = C, lnum = L, n = k }` — `k` lines added by `C` starting at `L` in `C`'s post-image.

The list ends with an open-ended base segment (`n = nil`, "and the rest of the file"), so the file's
length is never needed. A hunk is one splice: cut the segment list at the hunk's pre-image start and
end, harvest del attributions from the cut-out base segments, and substitute one owned segment.
Segment count grows by at most two per hunk, so the whole structure is O(hunks), independent of file
size.

## Layering

The patch sequence is:

1. Each commit in `base..target`, from the single log query above.
2. For a work-tree target, the uncommitted layer last, tagged `M.WORKTREE`. `build_model` already
   fetches this as `git diff HEAD` (`worktree_diff`), so it costs **no extra subprocess**, and
   `provenance.map_zero_sha` is no longer needed.

Untracked files have no patch at all; their lines get no `prov` entry, and `combined_owner`'s
existing "unattributed add in a work-tree review -> `M.WORKTREE`" fallback already handles them.

## Merges: first-parent is the model, not a limitation

`git log -p` emits no patch for merge commits, so composition walks `--first-parent`: the merge's
patch is its net effect over its first parent, i.e. the whole side branch's contribution credited to
the merge commit rather than to the side-branch commits individually.

That is the intended semantics, not a compromise. Review state is already scoped to the branch
(`state_dir` is keyed by branch name), so a commit reviewed on `side` and then merged into `main`
shows up unreviewed on `main` today too — the same way a cherry-pick does. In the context of the
branch containing the merge, the merged-in changes *are* novel. And the fix is trivial and
discoverable: mark the merge commit seen in commit scope. The lineage machinery exists for the
iterative loop (review, revise, review the delta), which is unaffected.

The consequence is that **`Git:commits` must become first-parent too.** If the commit list kept
enumerating side-branch commits while composition walked first-parent, a line would render twice in
commit scope — once under the side-branch commit, once under the merge — and only the merge's copy
would cross into combined scope. Making both first-parent means the ordered commit list *is* the
ordered patch list.

This collapses the two into one query. `Git:log_patches` returns `{ sha, summary, files }` per
commit, which is simultaneously:

- the commit list `build_model` needs (replacing `Git:commits`),
- every commit's own diff (replacing `commit_diff` and the lazy `_commit_files` memo — a scope
  toggle now costs zero subprocesses instead of one per commit),
- the input to the composition walk.

There is no fallback path, no merge detection, and no `provenance.lua`.

## Async shape: nothing blocks the UI

Today's loader streams per-file: the buffer paints with everything "pending" and files settle one at
a time. Composition is one job, so that becomes a single settle — the buffer is either showing the
previous complete state or the next complete state, never a half-attributed one.

That is only an improvement if the job is genuinely off the UI thread, and **today most of the load
is not**. `build_model`, `dirty_sig` and every call in the open path use `Git:run`, which is
`vim.system(...):wait()` — a synchronous block on the main loop. The live poll therefore stalls the
editor every 1500ms for the duration of `git diff HEAD` + `status -uall`, whether or not anything
changed. Removing the blames without fixing this would leave the worst remaining stall in place.

So the refresh becomes a single async pipeline:

1. Fan out the independent queries with `Git:run_async` — `rev-parse HEAD`, the net diff, the
   work-tree diff, untracked, and (only when needed, see below) the log walk. They are independent,
   so they go out together and a small join counts completions rather than chaining them.
2. When all have landed, do the pure work — `diff.parse`, composition, store load — and then repaint
   **once**, atomically.
3. Nothing paints in between. There is no partial state to render, so the throttled
   `schedule_streaming_render` collapses to a single repaint at the end of the pipeline; the
   generation guard (`_load_gen`) and buffer-validity checks stay and now cover the whole pipeline
   rather than one file's blame.

`Git:run_async` already schedules its callback on the main loop, and under the injected test runner
it invokes the callback synchronously, so the join drains deterministically in tests without
processes. That property must be preserved by the join helper.

The residual main-thread cost is the pure Lua: `diff.parse` over the diff text plus the composition
walk. That cannot be moved off the loop (no threads for Lua tables), but it is O(bytes) with no IO.
It should be measured on a large diff; if it exceeds a frame budget the answer is to chunk the parse
across `vim.schedule` slices, not to reintroduce per-file streaming. Not doing that up front.

## Reload and monitoring

Composition makes live reload strictly cheaper than the current per-file signature invalidation, and
the monitoring loop around it gets simpler at the same time.

**Skip the log walk when the commit set hasn't moved.** The committed layers depend only on
`(base, HEAD)`. The poll already resolves `HEAD`, so reload knows for free whether the commit set
changed. If it didn't — a save, i.e. the overwhelmingly common case — reuse the cached committed
segment state *and* the cached `{ sha, summary, files }` list, and re-apply only the work-tree layer
on top. That re-application is O(hunks) of pure Lua. A commit-set change re-runs the single log
walk. This replaces `_file_sigs` / `combined_file_sigs` and the per-path `_owner` carry-over, which
exist solely to avoid re-blaming unchanged files.

**Stop computing the work-tree diff twice.** `dirty_sig` generates exactly the text `worktree_diff`
is about to regenerate, hashes it, and throws it away; then `reload` asks git for it again. The poll
should hand the text it already has to the refresh. That removes one subprocess per tick *and* per
reload, and closes a TOCTOU window where the tree changes between the two calls.

**Stop running `status -uall` twice a second.** It stats the entire work tree on every tick, and it
exists only to notice new *untracked* files (`git diff HEAD` misses them). Move the untracked check
out of the tick: drive refreshes from `BufWritePost` / `FocusGained` autocmds, with the timer
demoted to a slow safety net (5s) that keeps catching out-of-editor changes. The diff hash still
catches every tracked change; an untracked file created outside the editor now appears within the
fallback interval instead of instantly, which is a fine trade for not stat-ing a large repo
continuously.

**Call `untracked` once.** `build_model` calls `git:untracked()` twice per build (`init.lua:274` and
`:282`) and uses the results for two different lists. One call, two consumers.

Rendering remains the last per-reload cost that is O(diff size). Per-file signatures are exactly the
input a partial repaint needs, so `combined_file_sigs` should survive with its consumer switched
from "which files to re-blame" to "which files to re-render", feeding
`plans/2026-06-25-incremental-section-render.md`. Out of scope here, but the signatures should not
be deleted.

Invariants:

- No git call on the UI thread. Every query in the open and refresh paths goes through
  `Git:run_async`; `Git:run` survives only for the one-shot resolution calls in the `:Glean`
  entrypoints (which already run before a buffer exists).
- The buffer never shows a partially attributed model: a refresh either repaints completely or not
  at all, and a superseded refresh drops itself rather than painting stale data over newer.
- A refresh that finds nothing changed must not repaint at all (the cursor must not move on an idle
  buffer — the property the current `dirty_sig` comparison protects).

- Combined-scope ownership of a line must equal the `(sha, lnum)` that `commit_owner` yields for
  that same line in that commit's own diff — this is what makes marks cross scopes. Composition
  enforces it by construction (both read `new_lnum`/`old_lnum` from the same commit patch), where
  blame's `-M`/copy detection can violate it.
- `prov` keys are final-image line numbers matching the net diff's `new_lnum`; `del_attr` keys are
  base-image line numbers matching the net diff's `old_lnum`.
- A line added and then deleted within the range must produce no entry in either map.
- A net-diff del line with no `del_attr` entry means "removed by the work tree" and must keep
  routing to `M.WORKTREE` (existing `combined_owner` behaviour).
- Renames must carry a path's accumulated state across the rename; a delete-then-re-add must reset
  it, so the re-added lines are owned by the re-adding commit and the deleted lines are attributed.
- The commit list and the composition chain must be the same first-parent sequence, so every line
  rendered in commit scope has exactly one identity and combined scope asks about that identity.
- Every git call must keep going through the injectable `Git:run`/`run_async` so tests never shell
  out to the ambient repo.

# Stages

## Fixture builder — DONE

Decisions: `merge = <name>` checks out `main` first, then `git merge --no-ff -m <msg> <name>`; the
merge commit *is* that spec entry's commit (no separate commit step). `branch = <name>` cuts the
branch from the previous commit and commits on it. Shape assertions live in the new
`lua/glean/testutil_test.lua` (rev-parse / rev-list --parents / show --name-status).

- Goal: `testutil.make_repo` can express every history the lineage tests need. Today each spec entry
  is `{ msg, files }` (write-and-commit only), which cannot produce a deletion, a rename, an empty
  commit, or a merge — i.e. most of the interesting cases.
- Add per-entry: `delete = { path, ... }` (`git rm`), `rename = { [from] = to }` (`git mv`, so the
  commit records a real rename), `empty = true` (`--allow-empty`), `branch = <name>` (start this
  commit on a new branch cut from the previous commit) and `merge = <branch>` (`--no-ff` merge).
  `shas[i]` keeps indexing spec entries so existing tests are untouched.
- [x] Tests: a spec exercising each new key produces the expected `git log --graph`-level shape —
  asserted via `rev-parse`/`rev-list --parents` and `git show --name-status`, not by eyeballing.

## Pure lineage module — DONE

Decisions:
- `lineage.compose` returns `{ [path] = { prov, del_attr } }`; state per path is
  `{ segs, del_attr }`, seeded with `{ { base = 1 } }` (the open-ended tail) or `{}` for a file
  added inside the range. `M.base_state()` exposes the seed.
- `blocks_of(hunk)` splits a hunk into contiguous change blocks, so the walk tolerates context
  lines even though `-U0` never emits them. Within a commit, hunk positions are pre-image
  coordinates, translated by a running offset.
- A `kind == "delete"` entry resets the path's state after attribution, so a re-add starts from
  nothing (the open base tail would otherwise survive the delete).
- A rename moves the state to the new path key before applying, so `del_attr` for a renamed file is
  keyed by base line numbers under the *new* path (which is how the net diff reports them).
- Segments are not coalesced when a splice leaves two adjacent base runs; count stays O(hunks)
  either way.
- The blob-content checker tries both the new and old path when looking up an owning commit's blob
  (a rename means the owner may know the file by its old name).
- The real-history tests use a local `log_patches` helper (the log walk + NUL split + `diff.parse`)
  rather than `Git:log_patches`, which is the next stage's work.
- Randomized generated commits pass `empty = true` since a random edit pass can leave content
  unchanged.

- Goal: `lineage.compose(patches)` returns `{ [path] = { prov, del_attr } }` from an ordered list of
  `{ sha, files }` (files as produced by `diff.parse`). No git, no nvim API — headless-testable like
  `diff` / `provenance`.
- Two distinct failure modes live in this module and each gets its own tests:
  **line arithmetic** (does a splice put the surviving lines at the right positions?) and
  **attribution** (does a line end up credited to the right commit at the right blob coordinate?).
  A real-history end-to-end test exercises both at once and therefore localizes neither, so it comes
  third rather than first.

To make both directly assertable the module exposes its seams:

- `lineage.splice(segments, at, remove_n, seg)` — the pure segment operation: cut `remove_n` lines
  starting at position `at`, substitute `seg`, return the new segment list plus the list of
  displaced origins. No shas, no diff structures, no git.
- `lineage.apply(state, sha, file)` — one commit's FileEntry against one path's state.
- `lineage.expand(segments, n)` — debug/testing helper returning a plain array of the origins of
  lines `1..n`. Turns any state into something a test can assert element by element, which is what
  makes both test groups readable.
- `lineage.compose(patches)` — the public entry point, built from the above.

### Line arithmetic

Table-driven tests over `splice` and `expand` alone, with placeholder origins (`"a"`, `"b"`, ...)
rather than shas — attribution is deliberately out of scope here, so a failure means the geometry is
wrong and nothing else. Hand-written *hunk coordinates* are fine at this level; hand-written raw
patch text is not used anywhere in this suite (that is what the real git query is for).

  - Replace in the middle: `splice` at 3 removing 2, inserting 2 -> positions 1,2 unchanged, 5,6...
    unchanged, 3,4 are the new segment.
  - Replace with a different width: removing 2 and inserting 5 shifts everything below by +3;
    removing 5 and inserting 2 shifts by -3.
  - Zero-width insert at 1 (prepend), at `n+1` (append), and in the middle.
  - Zero-width insert into the open-ended tail segment, where the file's length is unknown.
  - Delete-only splice (insert nothing) closes the gap with no leftover empty segment.
  - A splice exactly covering a whole segment removes it rather than leaving a zero-length one; a
    splice covering several segments plus part of a fourth cuts correctly at both ends.
  - A splice spanning a boundary returns *all* displaced origins in order, not just the first
    segment's.
  - Two splices in one commit, applied in pre-image order: positions for the second are interpreted
    against the unmodified pre-image, so applying them naively left-to-right against the mutating
    list is wrong. Assert with two hunks where the first changes the line count.
  - Segment count after k splices is O(k) — guard against per-line fragmentation, which would make
    a large file quadratic.

### Attribution

Tests over `apply` / `compose` with real sha-like ids but still hand-built FileEntries, asserting
the *identity* at each position via `expand`, plus the `del_attr` map. Geometry is already covered,
so these assert who-owns-what.

  - After c1 adds a line, `expand` shows that position owned by `(c1, lnum-in-c1)` and its
    neighbours still base-owned.
  - The `lnum` recorded is the commit's own `new_lnum`, not the position in the running image:
    assert with a commit that inserts above a previously-added line, so the two differ.
  - A del of a base-origin line records `del_attr[base_lnum] = { sha = C, lnum = old_lnum-in-C }`,
    with a fixture where `base_lnum ~= old_lnum` so an implementation that confuses them fails.
  - A del of an in-range-origin line records nothing at all.
  - Later commits overwrite earlier attribution for the same position; the earlier coordinate is
    gone from `prov`.
  - Base-origin survivors produce no `prov` entry.
  - Rename moves attributions to the new path key and empties the old.
  - Delete-then-re-add resets the path's state: base lines attributed to the deleter, new lines
    owned by the re-adder, nothing surviving across the gap.
  - The work-tree layer tags origins with `M.WORKTREE` and is otherwise an ordinary layer.

### Real histories

`lineage_test.lua` also builds throwaway repos, runs the actual `log_patches` query against them
through the injected runner, composes, and checks the resulting coordinates against the repo itself.
This is what catches places where git's real output differs from what the unit tests assumed.

Every assertion at this level reduces to one property, which needs neither blame nor a
hand-computed expectation:



> **A coordinate is correct iff the content at that coordinate is the line we claim it is.**

An origin `{ sha = C, lnum = L }` for a line whose text is `T` in file `P` is correct iff line `L`
of `git show C:P` is exactly `T`. A del attribution `del_attr[B] = { sha = C, lnum = L }` for a
deleted line of text `T` is correct iff line `L` of `git show C^:P` is `T` — and iff line `B` of
`git show <base>:P` is also `T`. A `prov` key `N` is correct iff line `N` of the target image is the
net diff's line at `new_lnum = N`.

So `lineage_test.lua` gets a helper `blob_line(repo, rev, path, lnum)` (over `git show`, cached per
rev+path) and a checker that, for a given fixture, walks **every** entry of **every** path's `prov`
and `del_attr` and asserts the content matches. This makes each fixture below a handful of lines of
setup plus one call, and it verifies coordinates in the only currency that matters — the bytes in
the blob. An off-by-one that a hand-written expectation would have quietly encoded twice (once in
the code, once in the test) fails immediately here.

The same checker is also run against the net diff from the other side: for every add line in
`git diff base...target`, `prov[dl.new_lnum]` must exist and its blob content must equal `dl.text`;
for every del line, either `del_attr[dl.old_lnum]` exists with matching pre-image content, or the
line is work-tree-removed.

- Tests (`lineage_test.lua`), each a real repo built via `testutil.make_repo`, each run through the
  content checker in full, plus the specific assertion named:
  - **Single edit.** One commit rewrites a middle line. The rewritten line is owned by that commit
    at that commit's own line number.
  - **Shifted by a later insert.** c1 rewrites line 3; c2 prepends two lines. The line is owned by
    `(c1, 3)` even though it now sits at position 5 — the origin must not track the final image.
  - **Shifted by an earlier insert.** c1 prepends two lines; c2 rewrites what was base line 3. The
    origin is `(c2, 5)`, c2's number, not the base's 3.
  - **Deletion attribution.** c2 deletes a base line that c1 had shifted down. `del_attr` is keyed
    by the **base** line number, with `lnum` the line's number in c2's pre-image — the two differ,
    so a fixture that doesn't shift would pass vacuously.
  - **Transient line.** c1 adds a line, c2 deletes it. It appears in neither map, and the net
    `base...target` diff indeed doesn't mention it.
  - **Rewritten twice.** c1 then c3 both rewrite the same line. Owned by c3; c1's coordinate is
    gone from `prov`.
  - **Pure prepend.** A commit whose only hunk is `@@ -0,0 +1 @@`. The inserted line owns position 1
    and everything below shifts by one — the `old_start + 1` splice rule.
  - **Pure append.** A commit whose only hunk is `@@ -N,0 +M @@` at end of file, exercising the
    open-ended tail segment (the file's length is never known to the walk).
  - **Adjacent hunks.** Two hunks in one commit close enough that `-U0` emits them separately but
    with no gap; splicing the first must not corrupt the second's coordinates (the walk processes
    hunks in pre-image order, so positions must be interpreted against the *unmodified* pre-image,
    not the partially-spliced image).
  - **Rename.** c2 renames and edits. Origins from c1 carry onto the new path; nothing remains
    under the old path; the edited line's `lnum` is its number in c2's post-image of the *new* path.
  - **Rename with no content change.** A pure rename commit (no hunks) still moves the state.
  - **Delete then re-add.** c2 deletes the file, c3 re-adds it with different content. Base lines
    are attributed to c2; c3's lines are owned by c3; no origins survive from before the delete.
  - **New file.** A file first added inside the range: every line owned by the adding commit, no
    base segment at all.
  - **Empty commit.** Contributes nothing and does not disturb the surrounding commits' coordinates
    (guards the NUL-split).
  - **Merge.** The merge fixture from the design section: the side branch's lines are owned by the
    merge commit, the side-branch commits contribute nothing, and the coordinates still satisfy the
    content check against the merge's blob.
  - **Randomized histories.** A small generator producing N commits of random edits (insert /
    delete / replace at random positions, occasionally a rename or a whole-file rewrite) over a
    handful of files, seeded deterministically, with a few dozen seeds. For each generated repo the
    content checker must pass in full. This is where the off-by-one and segment-splicing bugs that
    hand-picked fixtures miss will actually surface.

## Git plumbing

- Goal: `Git:log_patches(base, target)` returns an ordered (oldest-first) list of
  `{ sha, summary, files }` from one
  `git log --first-parent --reverse -p -U0 -M --no-color --format=%x00%H%x09%s` process, splitting
  on NUL and feeding each chunk to `diff.parse`. `Git:log_patches_async` is its `run_async`
  counterpart. `Git:commits` and `Git:commit_diff` are removed.
- Tests (`git_test.lua`, against a `testutil.make_repo` fixture through the injected runner):
  - On a linear fixture, the shas/summaries and their order match what `git log --reverse` reports,
    and each entry's `files` matches a direct `git diff sha^ sha` in path set and in per-hunk
    add/del line numbers — the `-U0` grouping must not change line numbering.
  - On a fixture with a merge, the list contains the merge and the main-line commits but not the
    side-branch commits, and the merge's `files` is its diff against its **first** parent.
  - A commit touching no files (empty commit) yields an entry with an empty `files` list rather
    than swallowing the following commit's patch — the NUL split must be robust to that.

## Blame-oracle equivalence

The content check of the previous stage proves the *coordinates* are real, but it cannot prove the
*attribution* is right: crediting the wrong commit would still pass if that commit happens to have
the same text at the same line (common — most commits don't touch most lines). Blame is the
independent authority on which commit, so both checks are needed and neither subsumes the other.

- Goal: high confidence that composition is a drop-in replacement, established *before* anything is
  rewired. This is where the risk actually lives — not in the module's internal logic but in
  whether it reproduces what blame told us.
  The oracle applies to **merge-free ranges only** — on a merge fixture the two are intended to
  disagree (blame reaches into the side branch, composition credits the merge), so that case is
  asserted against the composition answer directly, not against blame.
- Tests: on merge-free `make_repo` fixtures (linear edits; a rename; a file deleted then re-added;
  a line moved
  within a file; a file with only additions), for every path in the net `base...target` diff:
  - `compose(...).prov[new_lnum]` equals `parse_blame(git blame -p target -- path)[new_lnum]` for
    every **add** line of the net diff (context lines may legitimately differ: blame walks past
    base, composition does not).
  - `compose(...).del_attr` equals `build_del_map(git blame -p --reverse base..target -- path)` for
    every del line of the net diff.
  - Any deliberate divergence (the moved-line fixture, where blame's `-M` credits a pre-base commit
    and composition credits the in-range mover) is asserted explicitly as the *composition* answer,
    with a comment naming it as the intended correctness fix.

## Wire into Session

- Goal: combined-scope open runs one `log_patches_async` job instead of 2N blames. `_owner` is
  populated for all paths in one shot; `combined_owner`, `line_identity` and the renderer are
  unchanged. `build_model` sources its commit list from the same call, so `lazy_commit_files` and
  `_commit_files` are deleted.
- Tests:
  - Instrument the injected runner to count invocations: opening the multi-file fixture in combined
    scope issues **zero** `blame` calls and exactly one `log` patch call, and the count does not
    grow with the number of files (assert against a fixture with more files than
    `max_blame_jobs`).
  - The existing `init_test.lua` / `dirty_combined_test.lua` combined-scope seen/mark/render
    assertions pass unchanged — that suite is the real integration check.
  - Cross-scope round trip: mark a hunk in commit scope, switch to combined, the same lines render
    seen (and the reverse) — for a committed line and for an uncommitted work-tree line.
  - Scope toggle to commits and back issues no additional git calls.
  - On the merge fixture: the merge commit appears in commit scope with the side branch's changes
    as its own diff, the side-branch commits do not appear, and marking the merge's hunk makes those
    lines seen in combined scope. Each line has exactly one identity across the two scopes.

## Async refresh pipeline

- Goal: the whole open/refresh path is non-blocking. Add a small join helper over `Git:run_async`
  (fan out N queries, invoke a continuation once all land, preserving the injected runner's
  synchronous behaviour), convert `build_model` and `dirty_sig` to it, and reduce the pipeline to a
  single terminal repaint under the existing generation guard.
- Tests:
  - With a runner that records call order, a refresh issues its independent queries before any of
    them completes (fan-out, not a chain).
  - The buffer is written exactly once per refresh — instrument the render entry point and assert a
    single call, including when several queries land in the same tick.
  - A refresh superseded mid-flight (generation bumped by a scope switch or a second refresh) never
    writes to the buffer; the winning refresh's content is what lands.
  - Closing the buffer mid-flight aborts cleanly with no error from a late callback.
  - Under the injected runner the whole pipeline still completes synchronously within `open`, so the
    existing tests' `open()`-then-assert style keeps working. This constraint shapes the join
    helper; verify it explicitly.

## Reload without subprocesses

- Goal: a content-only refresh recomposes the work-tree layer over the cached committed state and
  issues no `log` walk; monitoring stops polling `status`.
- Sub-goals: reuse the poll's work-tree diff text instead of re-fetching; call `untracked` once;
  refresh on `BufWritePost` / `FocusGained` with the timer demoted to a 5s safety net.
- Tests:
  - Edit a file in the fixture work tree, trigger a refresh, assert the runner saw no `log` call,
    exactly one `diff HEAD`, one `ls-files --others`, and that the edited file's new lines are
    attributed to `M.WORKTREE` while an untouched file's committed ownership is preserved
    byte-identically.
  - Commit that edit and refresh: the log walk re-runs exactly once, and the previously
    WORKTREE-owned lines are now owned by the new commit — a mark made on them before the commit
    migrates (the behaviour `commit-migrate-marks` already covers; keep it green).
  - An idle refresh (nothing changed) performs no render and leaves the cursor where it was.
  - Creating an untracked file outside the editor is picked up by the fallback timer; saving a
    tracked file in the editor is picked up by the autocmd without waiting for it.
  - Suspend/resume with a work-tree change while hidden still reconciles (`suspend_test.lua` green).

## Retire dead code

- Goal: delete everything composition obsoletes.
- Removals: `Session:blame_ranges`, `_blame_ranges`, `has_del_lines`, `del_attribution` /
  `del_attribution_async`, `del_child`, `compute_provenance`,
  `load_owner` / `load_owner_async` / `load_combined_owners`, the worker queue (`loader_pump`,
  `_load_queue`, `_load_idx`) and the `max_blame_jobs` config key, `Git:blame`, `Git:blame_async`,
  `Git:reverse_blame`, `Git:reverse_blame_async`, `Git:commits`, `Git:commit_diff`, and
  `provenance.lua` + `provenance_test.lua`. `parse_blame` moves into `lineage_test.lua` as the
  oracle helper, since no production code calls it any more.
- The generation guard (`_load_gen`) is kept and widened to cover the whole refresh pipeline. The
  throttled `schedule_streaming_render` goes: with one atomic repaint per refresh there is nothing
  to coalesce. `combined_file_sigs` / `_file_sigs` also stay, repurposed as the input to incremental
  rendering.
- Tests: the full suite (`nvim -l lua/glean/run_tests.lua`) stays green; add no new tests here —
  this stage must be behaviour-preserving by definition. `max_blame_jobs` disappearing from
  `M.config` is a user-visible breaking change; note it in the README.
