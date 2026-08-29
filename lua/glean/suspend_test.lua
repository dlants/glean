-- A glean buffer that is in no window detaches from all background work (live
-- work-tree poll + blame loader) and re-attaches when it is displayed again.
-- Run with:
--   nvim -l lua/glean/suspend_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

local repo = testutil.make_repo({
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n" } },
})

local calls = 0
local function inject_run(args)
  calls = calls + 1
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

local function write(text)
  local f = assert(io.open(repo.root .. "/f.txt", "w"))
  f:write(text)
  f:close()
end

local function open(o)
  o = o or {}
  return glean.open({
    base = "HEAD",
    target = glean.WORKTREE,
    repo_root = repo.root,
    run = inject_run,
    open_window = o.open_window or false,
    state_dir = o.state_dir or vim.fn.tempname(),
  })
end

local function body(s)
  return table.concat(api.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
end

write("one\nTWO\nthree\n")

-- A suspended session runs nothing: the background entry points are inert, no
-- git subprocess is spawned, and the buffer keeps its pre-suspend content even
-- though the work tree moved underneath it.
do
  local s = open()
  local before = body(s)
  h.assert_true("suspend: TWO rendered before suspend", before:find("TWO", 1, true) ~= nil)

  s:suspend()
  write("one\nTHREE_X\nthree\n")
  local n = calls
  s:start_live()
  s:start_owner_loader()
  s:streaming_render(s._load_gen)
  h.assert_true("suspend: no git calls while suspended", calls == n)
  h.assert_true("suspend: no live timer while suspended", s._timer == nil)
  h.assert_true("suspend: buffer unchanged while suspended", body(s) == before)

  -- Resume reconciles against the work tree that moved while we were hidden.
  s:resume()
  local after = body(s)
  h.assert_true("resume: picks up the change made while hidden",
    after:find("THREE_X", 1, true) ~= nil)
  h.assert_true("resume: live timer running again", s._timer ~= nil)
  s:stop_live()
end

-- Suspend/resume are idempotent, and marks made before suspending survive it.
do
  write("one\nTWO\nthree\n")
  local s = open()
  local row
  for r = 0, api.nvim_buf_line_count(s.buf) - 1 do
    local t = s.row_map[r]
    local line = api.nvim_buf_get_lines(s.buf, r, r + 1, false)[1]
    if t and t.li and line and line:find("TWO", 1, true) then row = r break end
  end
  h.assert_true("idempotent: found +TWO row", row ~= nil)
  local id = s:row_identity(s.row_map[row])
  s:toggle_seen(row)

  s:resume() -- not suspended: no-op
  h.assert_true("idempotent: resume on active session is a no-op", not s._suspended)
  s:suspend()
  s:suspend()
  h.assert_true("idempotent: double suspend stays suspended", s._suspended)
  s:resume()
  h.assert_true("idempotent: resume clears suspension", not s._suspended)
  h.assert_true("idempotent: seen mark survives suspend/resume", s:id_seen(id))
  s:stop_live()
end

-- Visibility wiring: leaving the last window suspends, re-displaying resumes,
-- and one split of two closing keeps the session attached.
do
  write("one\nTWO\nthree\n")
  local s = open({ open_window = true })
  local win = s.win
  h.assert_true("visibility: active while displayed", not s._suspended)

  local other = api.nvim_create_buf(false, true)
  api.nvim_win_set_buf(win, other)
  vim.wait(200, function() return s._suspended end)
  h.assert_true("visibility: suspends when the buffer leaves its last window", s._suspended)
  h.assert_true("visibility: timer stopped when hidden", s._timer == nil)

  write("one\nHIDDEN_EDIT\nthree\n")
  api.nvim_win_set_buf(win, s.buf)
  vim.wait(200, function() return not s._suspended end)
  h.assert_true("visibility: resumes when re-displayed", not s._suspended)
  h.assert_true("visibility: renders the hidden-time edit on resume",
    body(s):find("HIDDEN_EDIT", 1, true) ~= nil)

  -- Two windows showing the buffer: closing one must not detach it.
  vim.cmd("split")
  local split = api.nvim_get_current_win()
  api.nvim_win_set_buf(split, s.buf)
  api.nvim_win_close(split, true)
  vim.wait(200, function() return s._suspended end)
  h.assert_true("visibility: still active with another window showing the buffer",
    not s._suspended)

  s:stop_live()
end

h.finish()
