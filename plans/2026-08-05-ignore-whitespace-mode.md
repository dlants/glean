# Objective and Context

> I'd like to see if we could add an "ignore whitespace mode". Can you come up with a plan for how that might work?

Add a per-review mode that hides changes Git considers whitespace-only, can be toggled without reopening the review, and preserves glean's core invariant that the model remains the source of truth and the buffer remains a read-only projection. Use Git's `--ignore-all-space` semantics: whitespace is ignored when comparing lines, while rendered text and source coordinates remain exact.

The implementation needs two related models rather than normalizing text in the renderer:

- The canonical model is always built from exact diffs. It remains authoritative for first-parent lineage composition, worktree ownership, persisted seen identities, comment anchoring, source coordinates, and live-change detection.
- The display model is either the canonical model in normal mode or a separately parsed `--ignore-all-space` diff in ignore mode. It controls which files, hunks, and changed lines are rendered and counted.
- Display lines retain Git's real `old_lnum` and `new_lnum`, so they can be mapped back to canonical ownership and committed identities without changing the persisted store schema.
- Untracked files are unchanged by the mode because they have no pre-image against which whitespace can be ignored.

Relevant entities:

- `Git` in `lua/glean/git.lua` owns every Git invocation and parses unified patches into `FileEntry`, `Hunk`, and `DiffLine` values.
- `build_model_async` and `assemble_model` in `lua/glean/init.lua` fan out the exact net diff, first-parent patches, worktree patch, and untracked listing.
- `Session` owns scope, model data, ownership caches, rendering, actions, polling, and per-buffer runtime state.
- `lineage` composes exact first-parent patches into add/delete ownership indexed by actual post-/pre-image line numbers.
- `state` persists committed line-number identities and exact-content worktree marks/comments. These records should be shared between whitespace modes rather than duplicated.

Relevant files:

- `lua/glean/git.lua` — add a normalized diff-options argument to diff-producing methods while keeping exact queries as the default.
- `lua/glean/init.lua` — hold canonical/display models, rebuild and cache both modes, toggle the mode, render its status, and keep actions anchored to canonical identities.
- `lua/glean/lineage.lua` — should continue receiving exact patches; tests should prove ignored display patches never enter composition.
- `lua/glean/state.lua` — no schema change is intended, but comment and worktree-mark resolution must be audited against hidden display lines.
- `lua/glean/git_test.lua` — hermetic Git behavior and exact argument/patch tests.
- `lua/glean/reload_test.lua` — live polling, patch-cache reuse, and mode-toggle refresh tests.
- `lua/glean/init_test.lua` — rendering, actions, ownership, comments, header, scope, and keymap integration tests.
- `README.md` — document configuration, keymap, label, and exact `--ignore-all-space` semantics.

# Design

Add `ignore_whitespace = false` to setup/open options and `Session`. Bind `W` in the review buffer to `Session:toggle_ignore_whitespace()`. The header should append an explicit `ignore-whitespace` label while enabled. The mode is session/view state, not persisted review state.

Introduce a small Git-level diff option representation, preferably a boolean or normalized immutable argument list produced by one helper. Every API that produces a display patch (`diff`, `combined_diff`, `diff_to_worktree`, `worktree_diff`, and `log_patches`, including async/root variants) should accept it and insert `--ignore-all-space` in the option position before refs and `--`. Do not change `Git:run`, `diff.parse`, untracked synthesis, `show`, or source-buffer contents.

Refactor model acquisition to distinguish canonical inputs from display inputs:

- Exact first-parent patches and the exact worktree diff remain the canonical ownership input in both modes.
- In normal mode, display files/commits reuse the canonical parsed objects where safe.
- In ignore mode, fetch an ignored net diff and ignored per-commit patches for rendering, while retaining exact patches for lineage. For worktree reviews, fetch an ignored `HEAD` patch for the synthetic displayed commit but compose ownership from the exact `HEAD` patch.
- Cache exact and ignored committed patch lists independently by HEAD and mode, so toggling after the first load does not repeatedly walk history. A cache key must include both HEAD and normalized diff mode.
- Keep live polling exact. The exact `git diff HEAD` signature detects all repository movement and its returned text can feed the canonical worktree layer. When ignore mode is active, refresh additionally fetches the ignored display patch. This avoids stale source coordinates after whitespace-only edits and avoids using an ignored patch for lineage.

Keep `self.files` and `self.commits` as the active display model to minimize renderer/action churn, and add explicitly named canonical ownership fields such as `self.lineage_commits` and `self.lineage_worktree_files`. `load_lineage` must consume only those exact fields. `combined_owner` and `commit_owner` can continue mapping displayed lines by their actual old/new line numbers into exact provenance. Add assertions or focused tests for owner lookup misses rather than silently treating a visible changed line as unowned.

Do not normalize `DiffLine.text`, hashes, comment content, intra-line offsets, or seen records. A visible non-whitespace line remains exact and therefore keeps valid byte columns, source jumps, committed identities, sticky marks, and content hashes. Whitespace-only rows simply do not exist in the ignored projection. Switching back restores them and their existing review state.

Comments need an explicit hidden-line policy. Resolve comments against the canonical exact model so enabling ignore mode does not mark a comment outdated merely because its row is hidden. Render comments whose canonical anchor maps to a visible display line normally; keep comments on hidden whitespace-only rows in the comment summary with a distinct `hidden by whitespace mode` status and navigation that first disables the mode (or offers a deterministic reveal) before jumping. This preserves authored data and avoids conflating hidden with outdated.

Collapse state may continue using existing content-addressed keys. File/directory keys survive the toggle; hunk/marker keys may legitimately differ because the projection differs. Clear undo/redo on a mode switch because pending actions contain mode-specific row targets, then rebuild through the existing refresh-generation guard so stale async results cannot repaint over the newly selected mode. Preserve cursor semantically by path plus nearest old/new line coordinate, falling back to the file header if the current whitespace-only row disappears.

The buffer registry should continue to key by repository/base/target because `W` changes the existing review rather than opening a second review. Reopening with an explicit `ignore_whitespace` option should update the reused session to that requested mode and rebuild if needed; it must not silently retain a conflicting prior mode.

Side-by-side diff should set a window-local Neovim diff option equivalent to ignoring whitespace while the mode is enabled, but source buffers remain exact. This is presentation consistency only; cursor placement still comes from the displayed line's real old/new coordinates. Intra-line highlighting needs no normalization: ignored whitespace-only pairs are absent, while mixed semantic changes are refined against exact rendered strings.

Invariants:

- Exact first-parent and worktree patches are the only inputs to lineage and persisted identity resolution.
- Ignore mode changes projection and progress counts, never the review-store schema or exact line text.
- Every displayed changed line maps to a canonical owner and real source coordinate.
- Hidden comments/marks remain stored and reappear unchanged when normal mode is restored.
- Live polling detects exact repository changes in either mode; an ignored display fetch cannot replace the exact poll payload.
- Untracked files render identically in both modes.
- An async result produced for one whitespace mode cannot overwrite a newer mode selection.

Alternatives considered:

- Passing `--ignore-all-space` to every existing query is smaller but unsafe: ignored first-parent patches can omit line-count-changing whitespace edits and corrupt lineage composition.
- Filtering or normalizing parsed lines in Lua is rejected because it would require reconstructing hunks, pairing additions/deletions, preserving true coordinates, and maintaining byte-offset maps for intra-line highlights.
- Separate persisted stores or buffers per mode are unnecessary because committed identities and exact-content records remain valid across projections and users should be able to toggle in place.

# Stages

## Git diff options — completed August 5, 2026

- [x] Goal: Diff-producing Git methods accept a normalized whitespace mode and return ignored patches without changing default behavior; exact and ignored calls can coexist in one session.
- [x] Tests:
  - A fixture containing indentation-only, internal-spacing-only, blank-line whitespace, and semantic edits shows only semantic edits under `--ignore-all-space`.
  - Sync and async methods place the flag before refs/paths and produce equivalent parsed models.
  - `log_patches` and root-history variants honor the flag for display patches, while exact calls remain behavior-compatible.
  - Untracked synthesis is identical before and after ignored diff calls.
- Decisions:
  - The Git-level option is a trailing `ignore_whitespace` boolean for synchronous methods and the argument immediately before `cb` for asynchronous methods. Async methods retain their prior callback-only calling form for compatibility.
  - The shared option helper is also applied to `range_diff`, since it is a diff-producing API, while `poll_async` intentionally remains exact and untracked synthesis remains option-free.
  - The blank-line fixture changes an empty line to a whitespace-only line. A newly inserted blank line is not hidden by Git's `--ignore-all-space` semantics and is therefore outside the promised behavior.

## Canonical and display models — completed August 5, 2026

- [x] Goal: `build_model_async` returns active display files/commits plus exact lineage inputs, with separate cache keys for exact and ignored committed patches.
- [x] Tests:
  - In ignore mode, whitespace-only files/hunks disappear from both combined and commit scopes, while mixed semantic changes remain.
  - Exact lineage composition receives exact patches even when the active display model is ignored.
  - Displayed additions/deletions after inserted or removed blank lines resolve to the correct commit owner and source line.
  - Toggling repeatedly reuses cached history for each mode and does not leak synthetic worktree commits into cached arrays.
- Decisions:
  - `self.files` and `self.commits` remain the active display projection; `self.lineage_commits` and `self.lineage_worktree_files` are the exact ownership inputs consumed by `load_lineage`.
  - Committed patch caches are stored by normalized mode (`exact` / `ignore-all-space`), with each entry carrying its resolved HEAD/target identity. A mode switch with a known HEAD can therefore reuse both histories independently.
  - Cached commit arrays never receive the synthetic worktree commit. Display assembly creates fresh commit arrays, and exact untracked entries are included only in the separately synthesized lineage worktree layer.
  - `ignore_whitespace = false` is now a setup/open default so model acquisition can select the display projection; the runtime keymap, toggle lifecycle, and header remain Stage 3 work.

## Runtime toggle and rendering — completed August 5, 2026

- [x] Goal: `W` toggles the mode in place, refreshes atomically, preserves a semantic cursor location, clears mode-specific undo/redo, and exposes the active mode in the header.
- [x] Tests:
  - The keymap and direct method remove and restore whitespace-only rows and update progress counts/header text.
  - A rapid double toggle with delayed fake runners renders only the final mode.
  - Scope toggling works independently in both whitespace modes.
  - Reopening an existing buffer with an explicit conflicting mode rebuilds that buffer rather than creating a duplicate or retaining stale content.
- Decisions:
  - Cursor restoration captures the displayed path, commit SHA when applicable, line kind, and Git old/new coordinates before refresh; the winning model selects the nearest same-path row and falls back to the file header (then the top row if the file is hidden entirely).
  - Mode changes clear undo and redo immediately, then use the existing refresh-generation guard. Replaced sessions also have their refresh and ownership generations invalidated so callbacks from a prior opener cannot repaint the shared buffer.
  - The active header label is appended to either scope name as `ignore-whitespace`; scope changes do not rebuild the model or alter the selected whitespace mode.

## Review-state and comment integration

- Goal: Seen marks, sticky overrides, and comments continue using exact canonical identities; hidden whitespace-only comments remain discoverable without being marked outdated.
- Tests:
  - Marking a semantic line in either mode should be reflected in the other mode.
  - A mark/comment on a whitespace-only row should disappear from the body in ignore mode and return unchanged afterward.
  - Hidden comments should appear in the summary with the hidden status, and navigation should reveal and jump to the exact row.
  - Repeated equal-content lines should not cause a hidden comment to re-anchor to a different visible line.
  - Undo/redo should not apply stale row targets across a mode transition.

## Live refresh and auxiliary views

- Goal: Exact polling, ignored display refreshes, ownership caches, intraline highlights, source jumps, and side-by-side diffs stay consistent during worktree edits.
- Tests:
  - A whitespace-only save in ignore mode should update exact signatures/coordinates without surfacing a changed row or corrupting ownership.
  - A later semantic edit should appear on the next poll with one exact poll diff, one ignored display diff, and no unnecessary exact history walk when HEAD is unchanged.
  - Committing while ignore mode is active should invalidate both relevant history caches and assign visible lines to the new commit.
  - Source jump and `D` should land on the correct real line after ignored blank-line changes; the split should ignore whitespace visually only while the mode is active.
  - Intraline byte highlights for mixed semantic/whitespace edits should remain within the exact displayed strings.

## Documentation and full regression

- Goal: Public behavior, configuration, keymap, limitations, and terminology are documented and all suites pass.
- Tests:
  - Update README examples with `ignore_whitespace = false`, the `W` keymap, the header indication, hidden-comment behavior, and the fact that this means Git `--ignore-all-space` rather than trimming rendered text.
  - Run `nvim -l lua/glean/run_tests.lua` from the repository root.
