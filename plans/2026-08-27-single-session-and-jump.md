# Objective and Context

Verbatim request:

> 1. I only want one glean session active per nvim instance. So there is "the glean session". When we select a new range for glean to look at, the old sessions are discarded (watchers dropped, buffers removed).
>
> 2. the point of this is that I want to allow navigating from the file to the glean buffer. So when I'm looking at a file, I should be able to run `:Glean jump`, and open that file + line in the current glean session. If the session doesn't exist, we should initialize a default one (like a bare :Glean).

## Entities involved

- `Session` (`lua/glean/init.lua`) — one review: `id`, `open_opts`, `git`, `store`, `base`, `target`,
  `scope`, `buf`, `win`, `row_map`, `collapse`, `_timer`, `_live_group`, `_suspended`, sticky float.
- Process-local registries in `init.lua` (all keyed by `buffer_key(repo_root, base, target)`, line ~113-130):
  `buffers[key]` (buffer id), `sessions[key]` (Session), `session_ids[key]` (`g1`, `g2`, ...),
  `views[key]` (ephemeral collapse overrides). `buffer_key` at ~140.
- `M.open(opts)` (~4627) — creates/reuses the buffer for a key, attaches the buffer-local autocmds
  (`BufReadCmd` reset, `BufWinEnter`/`BufWinLeave`/`BufHidden`/`WinClosed` visibility, `User
  GleanCommentsChanged`, `BufWipeout`/`BufDelete` teardown), builds the Session, registers it,
  shows the window, and kicks `refresh_model()`.
- `M.open_dirty(opts)` (~4807) — the bare `:Glean` entry point; resolves base/target via
  `M.resolve_dirty(git)` and delegates to `M.open`.
- `M.reset(session)` (~4605) — in-place hard reset; reuses buffer + `open_opts`.
- `M.live_sessions()` (~4593) — registry-ordered list of sessions with a valid buffer; the only
  session accessor used by `api.lua` (`M.sessions()`, `M.session(id)` at api.lua:17-59, and the
  `target(session)` helper at api.lua:100-109 which errors on ambiguity).
- `Session:stop_live()` (~4108) / `start_live()` (~4056) / `suspend()` / `resume()` /
  `close_sticky()` (~2064) — the background-work (timer + augroup) and float lifecycle.
- Navigation helpers already in place: `Session:file_header_row(path)` (~3401),
  `Session:expand_path(path)` (~3427), `Session:collapse_action(target)` (~2568),
  `Session:row_file(target)` (~850), `Session:restore_cursor(row)` (~2424),
  `Session:reveal_summary_comment(c)` (~3478 — the closest existing precedent: expand path,
  render, un-collapse marker runs for the path, render, park cursor).
- `show_buffer_in_window(buf)` (~4124) — reuse an existing window showing `buf`, else `botright vsplit`.
- `:Glean` user command (~4989) — subcommand dispatch (`comment`, `comments`, `log`, `prs`, `pr`,
  `branch`), plus `[base] [target]` positional forms, with a completion function listing subcommands.
- `Session:jump_target(row)` (~3541) — the *existing, opposite* direction (review row → source
  file/line). The new `:Glean jump` is its inverse; keep the names distinct in code
  (`jump_to_review` vs `jump_target`).

## Relevant files

- `lua/glean/init.lua` — registries, `M.open`, `:Glean` command, row_map, cursor helpers. All changes here.
- `lua/glean/api.lua` — session resolution for the agent surface; ambiguity paths become dead but must keep working.
- `lua/glean/init_test.lua`, `reload_test.lua`, `suspend_test.lua` — harness pattern:
  `testutil.make_repo()`, an injected `run`, `glean.open({..., open_window=false, state_dir=...})`.
- `lua/glean/overlay.lua` — file-buffer side (repo-relative path resolution via `buf_target`).

# Design

## Part 1 — a single global session

Replace the key-indexed registries with one singleton slot, but keep `buffer_key` as the *identity*
of what is being reviewed so that reopening the same range is still a cheap in-place reuse.

New module-local state:

```lua
local current = nil  -- { key, buf, id, session, view } | nil
```

`M.open(opts)` becomes:

1. Resolve `repo_root`, `git`, `store`, `key` exactly as today.
2. If `current` and `current.key == key` and `current.buf` is valid → reuse buffer, id and view
   (today's "existing buffer" path, including the previous-session invalidation:
   `prev:stop_live()`, `prev:bump_refresh()`, `prev._load_gen = prev._load_gen + 1`).
3. Otherwise **discard the current session** via a new `M.close_current()` and create a fresh buffer.

```lua
-- Tear down the one live session: stop its timer/augroup, close its sticky float,
-- and wipe its buffer. Idempotent; safe to call with no session.
function M.close_current()
```

`close_current` is the **only** teardown path — nothing else stops a timer, closes a float, or nils
`current`. It:
- captures and clears `current` first, then `session:stop_live()`, `session:close_sticky()`, then
  `pcall(nvim_buf_delete, buf, { force = true })`. Clearing first makes it re-entrant (the buffer
  delete re-enters via `BufWipeout`, which finds no `current` and returns) and means the
  `BufWipeout` triggered by wiping A can never clobber a newly installed session B.
- takes an optional `{ keep_buf = true }` for the caller that is already reacting to the buffer
  going away, so it skips the delete.

The `BufWipeout`/`BufDelete` autocmd therefore shrinks to a delegation: if `current` and
`current.buf == <this buf>`, call `M.close_current({ keep_buf = true })`. All other autocmds close
over `current` instead of `sessions[key]`; because the buffer is per-session now, they can simply
check `current and current.buf == buf`.

Session ids keep the monotonic `g<N>` counter (never reused), so agent-visible ids stay unambiguous
across replacements; the id is allocated once per buffer, i.e. only on the not-reused path.

`views[key]` collapses to `current.view`: reusing the same key preserves collapse overrides,
switching ranges drops them (they are explicitly ephemeral view-state).

`M.live_sessions()` keeps its signature (returns a 0-or-1 element array) so `api.lua` needs no
change; add `M.current_session()` returning the Session or nil for internal callers.

`M.reset(session)` is unchanged in behaviour: it reuses the same `open_opts`, so `M.open` takes the
same-key reuse path and the buffer survives.

Out of scope: `:Glean log` / `:Glean prs` buffers (`log_buffers`, `pr_buffers`) are separate
surfaces, not review sessions, and are left alone.

## Part 2 — `:Glean jump`

`:Glean jump` runs in a *file* buffer and moves the cursor into the review buffer at the row for the
current file + line.

Dispatch (in the `:Glean` command, and added to the completion list):

```lua
if args[1] == "jump" then M.jump_to_review() return end
```

```lua
-- From a work-tree file buffer, show the review at the current file+line.
-- Opens the default (`:Glean`) review when there is no live session.
-- Returns the review row (0-indexed) the cursor landed on, or nil.
function M.jump_to_review(opts)  -- opts: { bufnr, lnum } (tests)
```

Algorithm:

1. Capture `path` (repo-relative, via the same repo-root resolution `overlay.buf_target` uses) and
   `lnum` from the file buffer, *before* switching windows.
2. `local s = M.current_session()`; if nil, `s = M.open_dirty()`. Since the model loads
   asynchronously under the real runner, `open_dirty` cannot be followed immediately by a row
   lookup — stash the request on the session (`s._jump_after_refresh = { path, lnum }`) and have the
   render path consume it, mirroring the existing `_reveal_comment_after_refresh` mechanism
   (`Session:reveal_summary_comment`). Under an injected test runner the model lands synchronously,
   so the stash is consumed before `open_dirty` returns.
3. `s:show()` — focus/created window via `show_buffer_in_window(s.buf)`, keymaps already attached.
4. `s:goto_source_line(path, lnum)`.

```lua
-- Park the cursor on the review row showing post-image line `lnum` of `path`,
-- expanding whatever hides it. Falls back to the nearest reviewed line in the
-- file, then the file header. Returns the row, or nil when the file is not in
-- the review at all.
function Session:goto_source_line(path, lnum)
```

Implementation, following `reveal_summary_comment` step for step:

1. `if not self:file_header_row(path) then return nil end` — file absent from the diff.
2. `self:expand_path(path)` (file, seen section, enclosing dir rows) then `self:render()`.
3. Un-collapse every `marker` row belonging to `path` (`collapse_action(t).key = false`), re-render
   if anything changed — this is what reveals seen runs demoted into `✓ marked` markers.
4. Scan `row_map` for rows whose `row_file(t).path == path` and that carry a `line`; score each by
   `|post_lnum - lnum|` where `post_lnum` is the diff line's `new_lnum` (deletions have none and
   score against the following context line's `new_lnum`, i.e. they are only picked on an exact
   surrounding match). Pick the lowest score, ties → lowest row.
5. Fall back to `file_header_row(path)`.
6. `self:restore_cursor(row)`; return row.

Alternative considered and rejected: reusing `Session:restore_cursor_anchor(anchor)` (the scope-toggle
path). It is keyed on line *identity* (sha + lnum / content hash), which a plain file buffer does not
have, and its degradation tiers assume an anchor produced by `cursor_anchor()`. A dedicated
path+new_lnum scan is simpler and has no identity prerequisites.

## Interfaces

```lua
-- init.lua module-local
local current = nil
-- { key = string, buf = integer, id = string, session = Session|nil, view = table }

function M.current_session()            -- Session | nil
function M.close_current()              -- nil; idempotent teardown of `current`
function M.live_sessions()              -- { Session }  (0 or 1 element; unchanged shape)
function M.jump_to_review(opts)         -- opts: { bufnr?, lnum? } -> row | nil
function Session:goto_source_line(path, lnum) -- row (0-indexed) | nil
```

## Invariants

- At most one entry in `current` at any time; `M.live_sessions()` returns 0 or 1 sessions.
- Discarding a session drops *all* of its background work: no timer, no `glean_live_<buf>` augroup,
  no sticky float, and no orphaned buffer-local autocmds (they die with the wiped buffer).
- `close_current()` is the single teardown path: every route that ends a session (opening a new
  range, `:bwipeout`, `:bdelete`) goes through it, and it is re-entrant and idempotent.
- `close_current()` clears `current` before wiping the buffer, so the `BufWipeout` handler can never
  tear down the session that replaced it.
- Reopening the *same* `(repo, base, target)` still reuses the buffer, session id, and collapse
  overrides — `:e` (`M.reset`) and reopen must not renumber the review or lose fold state.
- Session ids are never reused, even after a discard.
- `api.lua`'s `M.session(id)` still resolves by id *and* by buffer number, and still errors (never
  silently nils) on an unknown id.
- `:Glean jump` never edits the review buffer content and never mutates the persisted seen model —
  the expansion it does is ephemeral collapse view-state only.
- `:Glean jump` from a file not in the review leaves the cursor where it is and reports it, rather
  than parking on an arbitrary row.

# Stages

## single session registry

**Status: done** (commit "Stage 1: single session registry").

Deviations from the design as written:
- `session_id_for(key)` became `next_session_id()`: ids are minted per new buffer rather than
  memoized per key, since the key→id table is gone. Reuse carries the id in `current.id`.
- `views[key]` became `current.view`, allocated alongside the id on the not-reused path.
- The `prev` invalidation (`stop_live` / `bump_refresh` / `_load_gen`) now only ever fires on the
  reuse path (`M.reset` / reopen); the different-range path goes through `close_current` instead.
- The buffer-local autocmds resolve the session through `M.current_session()` and compare
  `s.buf == buf`, so a stale buffer's autocmds are inert even before it is wiped.
- `api_test.lua`'s multi-session block was rewritten as a single-session block (second open
  discards the first, stale id errors, no-arg resolution is never ambiguous); its `wipe` helper
  now tolerates an already-wiped buffer.

- Goal: `sessions`/`buffers`/`session_ids`/`views` collapse into `current`; opening a second range
  discards the first (timer stopped, augroup gone, buffer wiped) while reopening the same range
  reuses the buffer, id, and collapse state.
- Tests (`init_test.lua`, extending the existing headless `open({..., open_window=false})` harness):
  - Wiping the review buffer directly (`:bwipeout`) leaves `M.live_sessions()` empty with A's timer
    stopped — i.e. the autocmd route and the open-a-new-range route reach the same end state.
  - Open range A, then range B: A's buffer is no longer valid, `M.live_sessions()` has exactly one
    entry (B), and A's `_timer` is nil and its `glean_live_*` augroup no longer exists
    (`nvim_get_autocmds` on the group errors / returns empty).
  - Open range A, collapse a file, reopen range A: same `buf`, same `session.id`, collapse override
    still set.
  - Open a work-tree session, mutate the work tree, open a different range, and let the poll
    interval elapse: no render/poll is attributed to the discarded session (assert via the injected
    runner's call log that no further git calls carry A's refs).
  - `M.reset` on the live session (the `:e` path) keeps the buffer and id, and the session is still
    the one `M.live_sessions()` returns.
  - `api.lua`: `M.sessions()` lists one entry after two opens; `M.session(<stale id>)` errors.

## jump into the review

**Status: done** (commit "Stage 2: jump into the review").

Deviations from the design as written:
- `goto_source_line`'s per-row scoring is factored into `Session:row_post_lnum(target)`, which
  resolves a row's post-image line number (a deletion borrows the next surviving line's `new_lnum`
  in its hunk, so it is only ever picked on an exact match).
- The deferred request rides in as `M.open(opts.jump)` rather than being assigned after
  `open_dirty` returns, since the render can complete inside `open`. The render consumer stores the
  landed row in `session._jump_row`, which `jump_to_review` returns (there is no window to read a
  cursor from when `open_window = false`).
- `jump_to_review` forwards its whole `opts` to `open_dirty`, so tests can inject `run`,
  `repo_root`, `state_dir`, and `open_window`.
- `:Glean jump` is documented in README's "Opening" section.

- Goal: `:Glean jump` from a file buffer parks the cursor on that file+line inside the review,
  expanding collapsed files, seen sections, dir rows, and seen-run markers as needed; with no live
  session it first opens the default review.
- Tests:
  - With a session open and the target file's diff *collapsed*, jumping to a changed line in that
    file lands on a row whose `row_map` entry resolves to that file and whose diff line's `new_lnum`
    equals the requested lnum.
  - Jumping to a line inside a *seen* run (rendered as a `✓ marked` marker) expands the marker and
    lands on the real line — and the persisted seen set is unchanged afterwards.
  - Jumping to an unchanged line in a file that is in the diff lands on the nearest reviewed line in
    that file (or the file header when the file has no rendered lines).
  - Jumping while in a file that is not part of the review returns nil and does not move the review
    cursor.
  - With no live session, `M.jump_to_review()` opens the default (`open_dirty`) review and still
    lands on the right row — exercised through the deferred `_jump_after_refresh` path, and
    asserted a second time by driving a refresh so the stash is consumed on a later render rather
    than inline.
