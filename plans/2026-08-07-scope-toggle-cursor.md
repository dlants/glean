# Objective and Context

> when toggling between combined and commit-by-commit mode, I'd like to keep the cursor in the same context.
>
> That is, if our cursor is in a hunk in commit-by-commit mode, when we switch to combined, we should place it on that same line (in combined mode), and vice versa.
>
> So in combined mode, we have a line (and commit under that line, possibly), and a file. Going to commit-by-commit should place us in that commit (if it's in the range), on that line (if that line has a visible hunk) in that file. Make this best effort.
>
> Going from commit-by-commit to combined should do the same. Approximately that line, in that file, if it's visible.

Entities involved (all in `lua/glean/init.lua` unless noted):

- `Session.scope` — `"commits"` | `"combined"`. `Session:set_scope(scope)` / `Session:toggle_scope()` (bound to `S`) flip it, call `apply_collapse` (commits only), `start_owner_loader`, `render`. No cursor handling today.
- `Session.row_map[row] -> target` — the row→model resolver. A diff-line target is `{commit,file,hunk,line,sec}` in commit scope and `{cfile,hunk,line,sec}` in combined; a file header carries `file`/`cfile` with no `hunk`/`line`.
- `Session:row_file(target) -> FileEntry` — the diff file a target belongs to (commit's file, or the combined `cfile`).
- `Session:row_identity(target) -> identity|nil` — the scope-invariant flat line identity. Asserts `owner_status(path) == "loaded"` in combined scope.
- `Session:line_identity(dl, path, owner, ord)` and the owner closures `Session:commit_owner(commit)` / `Session:combined_owner(path)`.
- `state.add_identity(sha,path,lnum)` / `del_identity(sha,path,lnum)` / `wt_identity(path,text)` (`lua/glean/state.lua`) — the three identity kinds. `wt` identities additionally carry `ord = canonical_ordinal(display_file, dl)`, which is **display-file relative and therefore scope-dependent**.
- `Session:owner_status(path)` — `nil` / `"loaded"`; combined identities are all `nil` until the blame/provenance loader finishes for that path.
- `Session:cursor_anchor()` / `Session:restore_cursor_anchor(anchor)` — existing path-and-lnum anchoring used by `set_ignore_whitespace` and `refresh_model({cursor_anchor=...})`.
- `Session:expand_path(path)`, `Session:file_header_row(path)`, `Session:restore_cursor(row)`, `Session:cursor_row()`.
- `Session:start_owner_loader()` / `_load_gen`, and `_refresh_gen`, the generation guards that let a superseded async pipeline drop itself. `Session:_reveal_comment_after_refresh` is the existing precedent for "finish this navigation after the next async completion".

Relevant files:

- `lua/glean/init.lua` — everything above; the change lives here.
- `lua/glean/state.lua` — identity constructors; may gain an identity key helper.
- `lua/glean/init_test.lua` — the main headless suite; already exercises `set_scope` both directions with a fake git runner.
- `lua/glean/lineage.lua` / `lineage_test.lua` — provenance composition that makes combined identities equal commit-scope identities.

# Design

The two scopes already share **one flat line-identity space** by construction: in commit scope a changed line's owner is `(commit.sha, new_lnum|old_lnum)`; in combined scope the owner is the composed blame provenance `(sha, that commit's own lnum)` for adds and the removing commit's pre-image `(sha, lnum)` for dels. So the same physical line yields the *same* identity in both scopes. Cursor preservation across a scope toggle is therefore not a coordinate-translation problem — it is "find the row carrying this identity in the new projection".

Flow:

1. `set_scope` captures a `scope_anchor` from the cursor row before flipping.
2. Flip scope, `apply_collapse`, `expand_path(anchor.path)` so the target file/section can't be hidden, `start_owner_loader`, `render`.
3. Resolve the anchor to a row by scanning the fresh `row_map` with a fixed priority ladder, then `restore_cursor`.
4. If the resolution ran while the combined ownership for that path was still pending, stash the anchor and re-resolve once the loader lands (generation-guarded, and abandoned if the user moved the cursor).

The anchor:

```
{ path, ident, ident_key, sha, lnum, kind, new_lnum, old_lnum, header }
```

`ident_key` is a string form of the identity that **ignores `ord`** (`ord` is display-file relative and differs between scopes for `wt` lines). `sha`/`lnum` are the identity's owner components kept separately for the degraded match. `new_lnum`/`old_lnum` are the current scope's raw display numbers, the last-resort positional fallback. `header = true` when the cursor was on a header/marker/summary row rather than a diff line.

Resolution ladder, first hit wins, ties broken by lowest row:

1. **Exact identity** — a line row in `row_map` whose `row_identity` has the same `ident_key`. The expected common case.
2. **Same owner commit, nearest owner lnum** — rows in `path` whose identity `sha` matches, minimizing `|lnum - id.lnum|`, preferring matching `kind`. Handles a line later modified or removed.
3. **Same path, nearest display lnum** — the existing `restore_cursor_anchor` scoring (prefer `new_lnum`, else `old_lnum`, penalize kind mismatch).
4. **`file_header_row(path)`**.
5. **Leave the cursor where it is** when `path` isn't displayed in the target scope at all.

Scope-specific behaviour falls out of the ladder rather than needing branches:

- commits → combined, line still present at tip: rule 1.
- commits → combined, line since deleted by a later commit: rules 1/2 miss the add, rule 3 lands near the deletion site.
- combined → commits: the combined row's owner sha *is* the commit to jump into, so rule 1 lands in the right commit's hunk. `WORKTREE`-owned lines resolve into the synthetic worktree commit (their `wt` identity is the same in both scopes modulo `ord`).
- an owner sha outside the reviewed range (a del attributed to a pre-base commit) simply fails rules 1–2 and degrades to 3/4.
- header rows (`header = true`) skip straight to rule 4.

Alternative considered and rejected: translating line numbers between the per-commit post-image and the combined post-image via the diff geometry. That is what the existing `restore_cursor_anchor` approximates, and it is wrong whenever the anchor commit isn't the tip. The identity space already encodes the exact answer, so use it.

`cursor_anchor`/`restore_cursor_anchor` get generalized in place (adding the identity fields and rules 1–2) rather than forked, so the whitespace-toggle and reload paths inherit the better matching. Their existing behaviour is a strict subset: with identities absent the ladder collapses to today's rule 3/4 scoring.

Invariants:

- `row_identity` asserts `owner_status(path) == "loaded"` in combined scope — the anchor capture and the row scan must both guard on `owner_status` and never call it on a pending file.
- Identity comparison must ignore `wt.ord`; including it would break `wt` matching across scopes (different display files ⇒ different canonical ordinals).
- Only rows present in `row_map` are candidates; collapsed content is invisible. `expand_path` must run *before* the render whose `row_map` we scan.
- Expanding for navigation uses direct `collapse` overrides (as `expand_path` already does) and must not push onto `undo_stack`.
- Collapse state is ephemeral view state; nothing here may write to the persisted store.
- The deferred re-resolve must no-op if `_refresh_gen`/`_load_gen` moved on, or if the cursor row changed since the provisional placement.
- No window (`self.win` nil/invalid, headless tests, `open_window = false`) ⇒ capture returns nil and restore is a no-op.

# Stages

## identity keying and anchor capture

- Goal: `Session:cursor_anchor()` returns an anchor carrying a scope-invariant `ident_key` plus owner `sha`/`lnum`, safely nil-ing those fields when the row is a header, a context line, or in a combined file whose ownership is still pending.
- Tests:
  - The same physical add line, anchored in commit scope and in combined scope, yields equal `ident_key` (drive both scopes off one fake-runner fixture with a multi-commit history where an early commit's line survives to the tip).
  - A del line anchored in combined scope carries the *removing* commit's sha, matching the anchor captured on that line in the removing commit's own diff.
  - A `wt` line's `ident_key` is equal across scopes despite differing `ord`.
  - Anchoring on a combined file with `owner_status ~= "loaded"` produces a path-only anchor and does not throw.

## resolution ladder

- Goal: `Session:restore_cursor_anchor` implements rules 1–5 and existing callers (`set_ignore_whitespace`, `refresh_model`) still behave.
- Tests:
  - Rule 1: with a synthetic `row_map`, an anchor whose identity is present lands exactly on that row, even when a nearer-by-display-lnum row of a different identity exists.
  - Rule 2: identity absent but owner sha present ⇒ nearest owner lnum in that commit, preferring same kind.
  - Rule 3/4/5 regressions: the existing ignore-whitespace-toggle and reload cursor-preservation tests still pass unchanged.

## wiring into set_scope

- Goal: `S` preserves the cursor in both directions, expanding whatever is collapsed to get there.
- Tests:
  - Fixture with ≥3 commits touching one file. Park the cursor on a line added by the *first* commit, `set_scope("combined")`, assert the cursor's row identity equals the pre-toggle identity (not merely the same file).
  - The reverse: park on a combined row blamed to the first commit, toggle to commits, assert the cursor sits in that commit's section on that line.
  - Toggling with the target file collapsed in the destination scope still lands on the line (`expand_path` ran) and leaves `undo_stack` empty.
  - A line added by commit 1 and deleted by commit 3: commits→combined lands in the same file near the deletion, not at row 0.
  - Cursor on a commit header (no combined counterpart) toggles to that file's combined header, or stays put when there is no path.
  - Round-trip toggle (`combined → commits → combined`) returns the cursor to the original row.

## deferred resolve under pending ownership

- Goal: toggling into combined before blame has landed still ends up on the right line.
- Tests:
  - With a fake runner that defers the blame response, toggle to combined: the cursor is provisionally placed in the right file, and after the loader completes it snaps to the exact identity row.
  - A second toggle (or a reload) before the loader completes cancels the pending resolve — the stale anchor never moves the cursor afterwards.
  - Moving the cursor manually between the provisional placement and the loader completing suppresses the snap.
