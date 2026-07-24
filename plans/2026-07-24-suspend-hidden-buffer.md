# Objective and Context

> I'm finding that when the Glean buffer is hidden, it's still kind of processing and updating things in the background. I want us to look into doing something where when the buffer leaves an active window, we kind of detach the buffer update process from it so we stop watching the files on disk and stop updating. We resume only when the buffer re-enters a window.

Entities involved (all in `lua/glean/init.lua` unless noted):

- `Session` — per-`(repo_root, base, target)` review object; owns `buf`, `win`, the model,
  the live timer (`_timer`), the blame loader generation (`_load_gen`) and the render
  throttle flags (`_render_dirty`, `_render_armed`).
- `Session:start_live()` / `Session:stop_live()` (~3006-3033) — `vim.uv` repeating timer at
  `LIVE_INTERVAL_MS` (1500ms) that polls `Git:dirty_sig()` and calls `reload()` on change.
  This is the "watching the files on disk" part.
- `Session:reload()` (~2958-3003) — rebuilds the diff model, re-blames changed files,
  `apply_collapse()` + `render()` + `start_owner_loader()`.
- `Session:start_owner_loader()` / `loader_pump()` / `schedule_streaming_render()` /
  `streaming_render()` (~419-483) — bounded-parallel background `git blame` workers plus a
  throttled repaint. This is the other background consumer: it keeps spawning subprocesses
  and repainting a buffer nobody is looking at.
- `Session:apply_intraline()` (~1420-1547) — `vim.schedule`-chunked word-diff painting,
  generation-guarded by `_intra_gen`; only runs as part of a render, so it stops for free
  once renders stop.
- `setup_keymaps(buf, session)` (~3037-3111) — creates augroup `glean_cursor_<buf>` with the
  cursor/sticky/window autocmds. Called only when `open_window ~= false`.
- `M.open()` (~3189-3290) — buffer creation, the `BufWipeout/BufDelete` teardown autocmd, the
  `buffers`/`sessions`/`views` registries keyed by `key`, and the `start_live()` call.
- `lua/glean/git.lua` — `Git:dirty_sig()`, the cheap worktree signature; runner injectable.
- `lua/glean/init_test.lua`, `lua/glean/dirty_combined_test.lua` — headless suites that build
  sessions with a fake git runner and call `reload()` directly.

# Design

Add an explicit **active/suspended** lifecycle to `Session`, derived from a single source of
truth: whether any window currently displays `self.buf` (`#vim.fn.win_findbuf(self.buf) > 0`).

Two new methods:

- `Session:suspend()` — no-op if already suspended. Sets `self._suspended = true`, calls
  `stop_live()`, bumps `self._load_gen` (which makes every in-flight blame callback,
  `loader_pump` recursion and pending `streaming_render` self-drop on their existing
  generation check), clears `_render_dirty`/`_render_armed`, and `close_sticky()`.
- `Session:resume()` — no-op if not suspended. Clears `_suspended`, then, because the worktree
  may have changed while hidden, compares `git:dirty_sig()` against the stored `self._sig`: on
  change it calls `reload()` (which re-renders and re-kicks the loader), otherwise it calls
  `render()` + `start_owner_loader()` to finish whatever blame work was abandoned. Finally
  `start_live()`.

Guards: `start_live()`, `start_owner_loader()` and `streaming_render()` return early when
`self._suspended`. These are the three entry points into background work; guarding them means
any *future* caller is also correctly inert while hidden, rather than relying on every call
site remembering to check.

Wiring: register the visibility autocmds in `M.open()`'s buffer-creation branch (next to the
existing `BufWipeout/BufDelete` autocmd) rather than in `setup_keymaps`, so they survive across
sessions for the same buffer and exist regardless of `open_window`. They look the session up
through `sessions[key]` (never capture the session value, which is replaced on reopen):

- `BufWinEnter` (buffer=buf) → `resume()`.
- `BufWinLeave`, `WinClosed`, `BufHidden` → `vim.schedule(...)` then re-derive visibility with
  `win_findbuf` and `suspend()` only if the count is zero. The deferral matters because
  `BufWinLeave` fires *before* the window is dropped, and because a buffer shown in two splits
  must stay active when only one split closes. Deriving from `win_findbuf` rather than
  bookkeeping per-event keeps this a single computation, matching the model-is-truth style of
  the rest of the plugin.

The existing `WinClosed` handler in `setup_keymaps` (re-pointing `session.win`) stays as is;
suspension is orthogonal and additive.

Rejected alternative: making the timer itself check visibility on each tick. It leaves the
timer and the blame loader running, still costs a `dirty_sig` subprocess every 1.5s per hidden
buffer, and doesn't address the streaming-render path — so it fixes the symptom, not the
mechanism.

Invariants:

- A suspended session performs no timers, no subprocesses and no buffer writes.
- On resume the buffer must reflect the current worktree, i.e. no stale render survives a
  hide/change/show cycle.
- Suspend/resume must not touch the persisted store, seen model, or collapse state — the
  buffer contents after resume must equal what a never-hidden session would show.
- A buffer visible in two windows stays active when one of them closes.
- Reopening via `:Glean` while hidden (which builds a fresh session) must end up active.
- `BufWipeout/BufDelete` teardown must still fully stop everything, whether suspended or not.

# Stages

## suspend/resume on Session

- Goal: `Session:suspend()`/`Session:resume()` exist and the three background entry points are
  guarded; no autocmd wiring yet, so behaviour is unchanged in normal use.
- Tests (`init_test.lua`, fake git runner):
  - Build a combined-scope session, `suspend()`, then mutate the fake runner's worktree output
    and assert that no re-render happens: buffer lines are byte-identical, and the injected
    runner records no new git invocations (assert on the fake runner's call log).
  - `resume()` after that mutation renders the new content, and the seen/collapse state
    recorded before suspending is still in effect afterwards.
  - `resume()` when nothing changed does not lose in-flight blame work: with a suspended
    session whose owner loader was abandoned mid-queue, after resume every combined file
    reaches `owner_status == "loaded"`.
  - `suspend()`/`resume()` are idempotent (double-suspend, resume-without-suspend are no-ops).

## autocmd wiring

- Goal: hiding the glean buffer suspends it; showing it again resumes it.
- Tests (headless; `nvim -l` has real windows, so drive this through actual window ops rather
  than calling the methods):
  - Open a session with `open_window = true`, `:hide` / switch the window to another buffer,
    assert `session._suspended` and `session._timer == nil`.
  - Re-display the buffer in a window, assert not suspended, timer live, and that a worktree
    change made while hidden is now visible in the buffer.
  - Show the buffer in two splits, close one: session stays active.
  - Wipe the buffer while suspended: no error, `sessions[key]` cleared, timer nil.
