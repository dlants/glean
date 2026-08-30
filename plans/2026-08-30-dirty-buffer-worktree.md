# Objective and Context

> let's revisit how the gutter in active buffers works, when the buffer is being
> edited. Right now we just bail on the gutter since we rely on diffing R and W,
> and the buffer's state W' is different from W. I wonder if there's something
> better we can do? For the sake of updating R, can we diff against W' instead of
> W? Maybe we can split up the diff and keep track of which lines have actually
> been edited, since the majority of the file is still the same?

The framing this plan adopts: **W is not "the file on disk", it is "the content
the reviewer is looking at"**. For a path with a loaded, modified buffer that is
the buffer's lines, W'. Everything downstream of W — `diff(H,W)`, the reviewed
baseline, the gutter projection — is already pure over a line array, so this is
not a new mechanism but a change of where the array comes from.

## Entities

- **H** — the file at the review's tip commit. `Session:wt_head_lines(path)`,
  `git show HEAD:path`, memoized in `self._wt_head`. Immutable while a baseline
  record lives.
- **B** — the file at the review's base (`self.base`). The left endpoint of the
  *net* combined diff. Immutable for the session's lifetime.
- **W / W'** — `Session:wt_file_lines(path)` (`readfile`, memoized in
  `self._wt_lines`). This is the accessor that must learn about buffers.
- **R** — the reviewed baseline, `Session:wt_versions(path).reviewed`, read from
  the `WORKTREE` store shard under H's content hash.
- **FileEntry** — `{ path, old_path, kind, hunks }`; a Hunk is
  `{ old_start, old_count, new_start, new_count, header, lines }`; a DiffLine is
  `{ kind = "context"|"add"|"del", text, old_lnum, new_lnum }` (`diff.lua`).
- **Op** — `baseline.align`'s output, `{ kind, text, a_lnum, b_lnum }`: a
  full-file alignment of two in-memory line lists via `vim.diff`.

## Model arrays derived from W

`Session:refresh_model` stores these off `build_model_async`; each is a diff with
W on its right-hand side, so each goes stale when a buffer is edited:

- `self.files` — display net `diff(B, W)`. The combined scope renders these
  (via the pass-through `compute_combined`), so this is what the review buffer
  and `file_status` read.
- `self.canonical_files` — exact net `diff(B, W)`; equals `self.files` unless
  `ignore_whitespace`. Comment resolution space.
- `self.lineage_worktree_files` — exact `diff(H, W)`, the floating work-tree
  layer `load_lineage` composes for provenance.
- `self.commits[#].files` for the `WORKTREE` sha — the commits-scope projection
  of `diff(H, W)`.

## Files

- `lua/glean/init.lua` — session, model refresh, `wt_file_lines`,
  `wt_versions`/`wt_seen_sets`, `load_lineage`, `file_status`, `toggle_marks`,
  `wt_matches`, `M.toggle_mark`.
- `lua/glean/gutter.lua` — `buf_target` (the `modified` bail), `M.refresh`, the
  `TextChanged` autocmd that currently clears.
- `lua/glean/baseline.lua` — `align`, `seen_adds`, `mark_adds`, `unmark_adds`.
- `lua/glean/diff.lua` — the FileEntry/Hunk/DiffLine shape and its parser.
- `lua/glean/git.lua` — `Git:show(ref, path)` for B and H text.
- `lua/glean/toggle_mark_test.lua` — the existing real-repo + real-session
  harness (`testutil.make_repo`, injected `run`) this plan's tests extend.

# Design

For every path with a dirty buffer, recompute the four model arrays' entries
**in process** from the buffer's lines, and leave every other path (and every
commit) exactly as git produced it. No git subprocess runs, because both left
endpoints — B and H — are immutable and cached.

Data flow on an edit to `path`:

```
TextChanged (debounced)
  -> Session:set_buffer_content(path, nvim_buf_get_lines(...))
       self._buf_lines[path] = lines            -- W' override for wt_file_lines
       invalidate per-path derived caches
       Session:patch_dirty()                    -- splice recomputed entries
       self:render(); gutter.refresh(bufnr)
```

`patch_dirty` recomputes, for each dirty path, `entry(B, W')` (net) and
`entry(H, W')` (work-tree layer) and replaces the matching FileEntry in each of
the four arrays, then nils `combined_files` and `_owner` so `load_lineage`
recomposes the work-tree layer over the cached `_committed_states` — the same
"content-only reload" path an ordinary poll already takes, pure Lua and O(hunks).

Three properties make this cheap and safe, and they are the reason the approach
is preferred over the alternatives:

- **Provenance does not move.** Blame is anchored on H. Added lines of
  `diff(H,W')` are uncommitted by construction, and deleted lines are named in H
  coordinates. So the expensive input — `git blame` — is never re-run for an
  edit.
- **Nothing persisted is keyed on a coordinate W' destabilizes.** Approved
  deletions are explicit H ranges; approved additions are *derived* from
  `diff(R,W)`; sticky overrides and comments are content-addressed. Feeding W'
  in where W was therefore cannot corrupt the store — it can only change what is
  displayed and classified.
- **`compute_combined` is a pass-through over `self.files`**, so splicing one
  entry is essentially free; the cost of a refresh today is entirely the git
  subprocesses this path skips.

## Alternatives considered

- *Incremental / split diffing, tracking which lines were edited.* Rejected.
  `vim.diff` over a whole file is sub-millisecond; the bottleneck is git and
  blame, which this design already avoids. An edit-tracking layer adds a second
  representation of "what changed" that can drift out of sync with the real diff
  and produce wrong seen-ness — a bad trade for optimizing the cheap half. If
  profiling ever shows the diff, the cheap win is a `changedtick` guard (in this
  plan from stage 3) rather than a partial diff.
- *Synthesize unified-diff text for dirty paths and feed it to
  `refresh_model` via `wt_diff_text`.* Rejected: it reuses the existing plumbing
  for `diff(H,W)` but leaves the net `diff(B,W)` coming from git, i.e. still
  read from disk and still stale.
- *Keep bailing, poll faster.* Rejected: no poll can see unwritten content.

## Interfaces

```lua
--- Pure: an Op list (baseline.align output) as a FileEntry's hunk list, with
--- `context` lines of context around each changed block and adjacent blocks
--- coalesced, matching git's hunk splitting. Lives in diff.lua (no vim.diff
--- call, so diff.lua stays IO- and API-free).
--- @param ops glean.baseline.Op[]
--- @param context integer|nil defaults to 3
--- @return table[] hunks
function diff.hunks_from_ops(ops, context)

--- Pure: `{ path, old_path, kind, hunks }` for the diff of two line lists.
--- `kind` is "add" when #a == 0, "delete" when #b == 0, else "modify".
--- @param opts { ignore_whitespace: boolean|nil, context: integer|nil }
function Session:text_file_entry(path, a, b, opts)

--- Override W for `path` with an editor buffer's content, or clear the
--- override when `lines` is nil (the buffer was written or wiped). Invalidates
--- the path's derived caches, re-splices the model and re-renders.
function Session:set_buffer_content(path, lines)

--- The tip (H) and base (B) texts, memoized per path; B is a new cache
--- alongside the existing `_wt_head`.
function Session:wt_base_lines(path)

--- Recompute and splice the four W-derived FileEntry lists for every path in
--- `self._buf_lines`. Called by `set_buffer_content` and at the end of
--- `refresh_model` (a git refresh must not resurrect on-disk entries for a
--- path whose buffer is still dirty).
function Session:patch_dirty()
```

`self._buf_lines : table<string, string[]>` is the one new piece of session
state. It is ephemeral view-state in the same sense as `collapse`: never
persisted, dropped on `BufWritePost` (disk and buffer agree again) and on
`BufWipeout`.

## Invariants

- `Session:wt_file_lines(path)` is the *single* accessor for W. After this
  change every consumer (`wt_versions`, comment file-projection, `wt_matches`)
  must go through it and therefore see W' automatically; no consumer may read
  the path off disk itself.
- `diff(H, R)` stays add-only and R is never shrunk below H. Marking from a
  dirty buffer advances R over buffer lines; if the user then reverts the
  buffer, R sits *ahead* of W and those approved additions simply stop appearing
  in the diff. This is acceptable and self-correcting; the add-only invariant is
  untouched.
- Approved deletions stay stored as H line ranges and are never re-derived from
  a diff, so a dirty buffer cannot renumber them.
- A dirty path's provenance must be composed from `diff(H, W')`, not
  `diff(H, W)`, or `combined_owner` will attribute add lines by stale line
  numbers. Hence `_owner` invalidation is mandatory in `set_buffer_content`.
- `refresh_model` must re-apply `patch_dirty` after installing git's results,
  or a poll landing mid-edit reverts the gutter to disk content.
- A path with **no** loaded buffer, and any commit-targeted (non-worktree)
  session, must behave exactly as today — this feature is invisible to them.
- Binary / very large buffers must not be diffed on every keystroke; the same
  guards `parse_untracked` applies (NUL byte) plus a line-count ceiling.
- The existing per-render memo caches (`_wt_lines`, `_wt_versions`, `_wt_seen`,
  `_live_diff_cache`, `combined_files`, `_owner`) must all be invalidated
  together, or seen-ness and geometry will disagree.

# Stages

## the pure diff-to-FileEntry converter

- Goal: `diff.hunks_from_ops` and a `Session:text_file_entry` that produce a
  FileEntry byte-for-byte equivalent to what `diff.parse` returns for the same
  two versions.
- Tests (new `lua/glean/hunks_test.lua`, plus the real repo harness):
  - Round-trip against git: for a handful of file pairs written into a
    `testutil.make_repo`, assert `text_file_entry(B, W)` equals
    `diff.parse(git diff)` for the same pair — same hunk headers, same line
    kinds, same `old_lnum`/`new_lnum`. This is the whole correctness argument
    for the stage and must cover adjacent changed blocks (coalescing), a change
    at line 1, a change at EOF, a pure append, a pure delete, an empty left
    side and an empty right side.
  - `ignore_whitespace` produces the same entry as `git diff -w`.

## W' as the source of truth for one path

- Goal: `set_buffer_content` + `patch_dirty` exist; with an override installed,
  `file_status`, the review buffer's rendering and `wt_seen_sets` all describe
  the buffer rather than the disk. The gutter still bails (unchanged) so this
  stage is observable only through the API.
- Tests (extend `toggle_mark_test.lua` or a new `dirty_buffer_test.lua`, using
  the existing real-repo session):
  - Install an override that appends a line; `file_status` gains a mark on the
    new row and every previously-marked row keeps its mark at its *shifted*
    number — i.e. seen-ness follows content, not line number.
  - Mark a row, then edit *that* row via an override: exactly that row goes
    unseen and its neighbours stay seen (the baseline's headline property, now
    under W').
  - Mark a row, then edit an unrelated row far above it: the marked row stays
    seen despite renumbering.
  - Uncommitted deletions: delete lines in the override and assert the folded
    del markers land on the right rows and that a previously approved deletion
    (stored as an H range) is still reported seen.
  - Provenance: a committed add line whose row moved under the override still
    reports the same `(sha, lnum)` identity — the same-identity-in-both-scopes
    property.
  - `refresh_model` while an override is installed leaves the override winning.
  - Clearing the override restores exactly the pre-override `file_status`.

## wiring the editor to the model

- Goal: editing a review file repaints its gutter live; writing or reverting it
  returns to the git-driven path. The `modified` bail in `buf_target` is gone
  and the `TextChanged` clear is replaced by a debounced update.
- Details: debounce ~150ms per buffer; skip when `b:changedtick` is unchanged;
  drop the override on `BufWritePost` (then poll as today) and on `BufWipeout`;
  guard on buffer size and on the buffer belonging to a live work-tree session.
- Tests (headless, driving real buffers as `toggle_mark_test.lua` already does
  for `M.toggle_mark`):
  - Edit a file buffer, run the debounce to completion, assert the extmark
    signs moved to the rows the edit implies.
  - Undo back to the original content: the signs return to their original rows
    and the override is equivalent to no override.
  - Write the buffer: the override is dropped and the poll-driven refresh
    produces the same signs — no flicker to a different projection.
  - A buffer outside the repo, and a buffer while no session is live, install
    no override and paint nothing.

## marking from a dirty buffer

- Goal: `:Glean toggle-mark` / `gm` work in a modified buffer. The `modified`
  refusal in `M.toggle_mark` and the `wt_matches` staleness gate are replaced by
  "the model's W for this path is this buffer's content", which is now true by
  construction.
- Details: `wt_matches` becomes a check that the override is current (compare
  against `_buf_lines[path]`), keeping its role as a guard against acting on
  coordinates the model has not caught up to, rather than being deleted.
- Tests:
  - Mark a hunk in a modified buffer; the store's R advances over the *buffer's*
    lines, and `file_status` reports the rows seen without a write.
  - Write the buffer afterwards and poll: the same rows are still seen — the
    marks survive the transition from override to disk.
  - Revert the buffer (`:e!`) after marking: no error, `diff(H,R)` is still
    add-only, and the file's unreviewed count is consistent.
  - The layered undo step (`bufundo`) still reverses a mark made while dirty.
