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

-- 5. Ignore-whitespace live refreshes keep the poll and lineage exact. A
-- whitespace-only save changes the exact signature/canonical model without
-- surfacing a display row; a later semantic edit fetches one additional ignored
-- HEAD patch, keeps real coordinates/intraline strings, and a commit invalidates
-- both history-mode caches.
do
  local live_repo = testutil.make_repo({
    { msg = "base", files = { ["mode.txt"] = "top\n\nvalue here\n" } },
  })
  local live_calls = {}
  local function live_run(args)
    live_calls[#live_calls + 1] = vim.deepcopy(args)
    local cmd = { "git" }
    for _, arg in ipairs(args) do cmd[#cmd + 1] = arg end
    local res = vim.system(cmd, { cwd = live_repo.root, env = live_repo.env, text = true }):wait()
    return { code = res.code, stdout = res.stdout, stderr = res.stderr }
  end
  local function live_count(pred)
    local n = 0
    for _, args in ipairs(live_calls) do if pred(args) then n = n + 1 end end
    return n
  end
  local function has_flag(args, flag)
    for _, arg in ipairs(args) do if arg == flag then return true end end
    return false
  end
  local function head_diff(args, ignored)
    return args[1] == "diff" and args[#args] == "HEAD"
      and has_flag(args, "--ignore-all-space") == ignored
  end
  local function log_mode(args, ignored)
    return args[1] == "log" and has_flag(args, "--ignore-all-space") == ignored
  end
  local function body(session)
    return table.concat(api.nvim_buf_get_lines(session.buf, 0, -1, false), "\n")
  end
  local function row_with(session, text)
    for row, target in pairs(session.row_map) do
      local line = api.nvim_buf_get_lines(session.buf, row, row + 1, false)[1]
      if target and target.line and line == text then return row end
    end
  end

  local mode = glean.open({
    base = live_repo.shas[1], target = glean.WORKTREE,
    repo_root = live_repo.root, run = live_run, open_window = false,
    state_dir = vim.fn.tempname(), ignore_whitespace = true,
  })
  mode:poll({ baseline = true })
  local baseline_sig = mode._sig
  local function live_write(text)
    local f = assert(io.open(live_repo.root .. "/mode.txt", "w"))
    f:write(text)
    f:close()
  end

  live_write("top\n   \nvalue here\n")
  live_calls = {}
  mode:poll()
  h.assert_true("ignore live: whitespace save updates exact signature", mode._sig ~= baseline_sig)
  h.assert_true("ignore live: whitespace-only file remains hidden",
    body(mode):find("mode.txt", 1, true) == nil)
  h.assert_eq("ignore live: poll stays exact", live_count(function(a) return head_diff(a, false) end), 1)
  h.assert_eq("ignore live: one ignored display HEAD patch",
    live_count(function(a) return head_diff(a, true) end), 1)
  local canonical_space
  for _, file in ipairs(mode.canonical_files) do
    for _, hunk in ipairs(file.hunks) do
      for _, line in ipairs(hunk.lines) do
        if line.kind == "add" and line.text == "   " then canonical_space = true end
      end
    end
  end
  h.assert_true("ignore live: canonical model retains whitespace row", canonical_space)
  h.assert_true("ignore live: exact worktree lineage retains whitespace edit",
    mode.lineage_worktree_files[1] ~= nil)

  live_write("top\n   \n  VALUE here\n")
  live_calls = {}
  mode:poll()
  local semantic_row = row_with(mode, "  VALUE here")
  h.assert_true("ignore live: later semantic edit appears", semantic_row ~= nil)
  h.assert_eq("ignore live semantic: one exact poll diff",
    live_count(function(a) return head_diff(a, false) end), 1)
  h.assert_eq("ignore live semantic: one ignored display HEAD diff",
    live_count(function(a) return head_diff(a, true) end), 1)
  h.assert_eq("ignore live semantic: no unchanged-HEAD history walk",
    live_count(function(a) return a[1] == "log" end), 0)
  local owner = mode:row_identity(mode.row_map[semantic_row])
  h.assert_eq("ignore live semantic: visible row is WORKTREE-owned", owner.kind, "wt")
  local jump = mode:jump_target(semantic_row)
  h.assert_eq("ignore live semantic: source coordinate is real line", jump.lnum, 3)
  vim.wait(100, function()
    return mode._intra_cache and mode._intra_cache["value here\0\0  VALUE here"] ~= nil
  end, 5)
  h.assert_true("ignore live semantic: intraline uses exact displayed strings",
    mode._intra_cache and mode._intra_cache["value here\0\0  VALUE here"] ~= nil)

  local original_win = api.nvim_get_current_win()
  api.nvim_win_set_buf(original_win, mode.buf)
  mode.win = original_win
  local before_diffopt = api.nvim_get_option_value("diffopt", {})
  local right_win, left_win = mode:diffsplit(semantic_row)
  h.assert_eq("ignore diffsplit: target cursor uses real coordinate",
    api.nvim_win_get_cursor(right_win)[1], 3)
  h.assert_true("ignore diffsplit: presentation ignores all whitespace",
    api.nvim_get_option_value("diffopt", {}):find("iwhiteall", 1, true) ~= nil)
  api.nvim_win_close(left_win, true)
  h.assert_eq("ignore diffsplit: transient diff option restored", api.nvim_get_option_value("diffopt", {}),
    before_diffopt)
  if api.nvim_win_is_valid(right_win) then api.nvim_win_close(right_win, true) end

  live_repo.run({ "add", "-A" })
  live_repo.run({ "commit", "-q", "-m", "semantic worktree edit" })
  local new_head = live_repo.run({ "rev-parse", "HEAD" })
  live_calls = {}
  mode:poll()
  h.assert_eq("ignore live commit: exact history cache rebuilt once",
    live_count(function(a) return log_mode(a, false) end), 1)
  h.assert_eq("ignore live commit: ignored history cache rebuilt once",
    live_count(function(a) return log_mode(a, true) end), 1)
  h.assert_eq("ignore live commit: exact cache keyed to new HEAD",
    mode._commit_patch_cache.exact.head, new_head)
  h.assert_eq("ignore live commit: ignored cache keyed to new HEAD",
    mode._commit_patch_cache["ignore-all-space"].head, new_head)
  local committed_row = row_with(mode, "  VALUE here")
  local committed_owner = mode:row_identity(mode.row_map[committed_row])
  h.assert_eq("ignore live commit: visible row belongs to new commit", committed_owner.sha, new_head)
end

-- `:e` (BufReadCmd) is a hard reset: the old session is torn down and a fresh
-- one takes over the same buffer with the same content.
do
  local s = open()
  local buf = s.buf
  local before = api.nvim_buf_get_lines(buf, 0, -1, false)
  local fresh = glean.reset(s)
  h.assert_true("reset: new session object", fresh ~= s)
  h.assert_eq("reset: same buffer", fresh.buf, buf)
  h.assert_eq("reset: same review id", fresh.id, s.id)
  h.assert_eq("reset: content repainted",
    table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), "\n"), table.concat(before, "\n"))
  api.nvim_buf_delete(buf, { force = true })
end

h.finish()
