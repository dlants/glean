-- Reload without subprocesses: a content-only refresh recomposes the work-tree
-- layer over the cached committed state (no log walk, one `diff HEAD`, one
-- `ls-files --others`), an idle check repaints nothing, and untracked files are
-- picked up by the safety-net tick rather than every event. Run with:
--   nvim -l lua/glean/reload_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

local repo = testutil.make_repo({
  { msg = "base", files = { ["f.txt"] = "a1\na2\na3\n", ["g.txt"] = "b1\nb2\nb3\n" } },
  { msg = "c1: edit f", files = { ["f.txt"] = "a1\nA2\na3\n" } },
})

local calls = {}
local function inject_run(args)
  calls[#calls + 1] = args
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

local function count(pred)
  local n = 0
  for _, args in ipairs(calls) do if pred(args) then n = n + 1 end end
  return n
end
local function is_log(args) return args[1] == "log" end
local function is_diff_head(args) return args[1] == "diff" and args[3] == "HEAD" end
local function is_ls_files(args) return args[1] == "ls-files" end

local function write(path, text)
  local f = assert(io.open(repo.root .. "/" .. path, "w"))
  f:write(text)
  f:close()
end

local function open()
  return glean.open({
    base = repo.shas[1],
    target = glean.WORKTREE,
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = vim.fn.tempname(),
  })
end

local function prov(s, path)
  local e = s._owner and s._owner[path]
  return e and e.prov or {}
end
local function same_prov(a, b)
  for k, v in pairs(a) do
    if not (b[k] and b[k].sha == v.sha and b[k].lnum == v.lnum) then return false end
  end
  for k in pairs(b) do if not a[k] then return false end end
  return true
end

-- 1. A content-only refresh: no log walk, one `diff HEAD` (the poll's, reused
-- by the rebuild), one untracked listing. The edited lines become
-- WORKTREE-owned; the untouched file's committed ownership is preserved.
local s = open()
local f_before = vim.deepcopy(prov(s, "f.txt"))
h.assert_true("open: f.txt owned by c1", prov(s, "f.txt")[2].sha == repo.shas[2])
do
  write("g.txt", "b1\nB2\nb3\n")
  calls = {}
  s:poll()
  h.assert_eq("edit refresh: no log walk", count(is_log), 0)
  h.assert_eq("edit refresh: one `diff HEAD`", count(is_diff_head), 1)
  h.assert_eq("edit refresh: one untracked listing", count(is_ls_files), 1)
  h.assert_eq("edit refresh: edited line is WORKTREE-owned",
    prov(s, "g.txt")[2].sha, glean.WORKTREE)
  h.assert_true("edit refresh: untouched file's ownership preserved",
    same_prov(f_before, prov(s, "f.txt")))
end

-- 2. An idle check does no work at all: no refresh, no repaint.
do
  local Session = getmetatable(s)
  local orig = Session.render
  local renders = 0
  Session.render = function(self, ...) renders = renders + 1 return orig(self, ...) end
  s:poll({ baseline = true, untracked = true })
  local cursor = s._sig
  calls = {}
  s:poll({ untracked = true })
  Session.render = orig
  h.assert_eq("idle: no repaint", renders, 0)
  h.assert_eq("idle: signature unchanged", s._sig, cursor)
  h.assert_eq("idle: no log walk", count(is_log), 0)
end

-- 3. Committing the edit moves the commit set, so the log walk re-runs exactly
-- once and the previously WORKTREE-owned lines are owned by the new commit.
do
  repo.run({ "add", "-A" })
  repo.run({ "commit", "-q", "-m", "c2: edit g" })
  local c2 = repo.run({ "rev-parse", "HEAD" })
  calls = {}
  s:poll()
  h.assert_eq("commit refresh: exactly one log walk", count(is_log), 1)
  h.assert_eq("commit refresh: line now owned by the new commit", prov(s, "g.txt")[2].sha, c2)
  h.assert_true("commit refresh: other file's ownership still c1",
    same_prov(f_before, prov(s, "f.txt")))
end

-- 4. An untracked file created outside the editor is invisible to `git diff
-- HEAD`, so the event-driven check misses it and the safety-net tick (which
-- pays for the tree walk) picks it up.
do
  write("new.txt", "fresh\n")
  calls = {}
  s:poll()
  h.assert_eq("untracked: event check does not walk the tree", count(is_ls_files), 0)
  local body = table.concat(api.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
  h.assert_true("untracked: not picked up by the event check",
    body:find("new.txt", 1, true) == nil)
  s:poll({ untracked = true })
  body = table.concat(api.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
  h.assert_true("untracked: picked up by the safety-net tick",
    body:find("new.txt", 1, true) ~= nil)
end

h.finish()
