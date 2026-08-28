-- Tests for Session:file_status — the gutter projection of a live work-tree
-- review, wiring composed ownership + line identities into gutter.project.
-- Run with:
--   nvim -l lua/glean/file_status_test.lua
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
  { msg = "c1", files = { ["f.txt"] = "one\ntwo\nthree\nfour\n" } },
})
do
  local f = assert(io.open(repo.root .. "/f.txt", "w"))
  f:write("one\ntwo more\nthree\nfour\nfive\n")
  f:close()
end

local function inject_run(args)
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

local function open(target, state_dir)
  return glean.open({
    base = repo.shas[1],
    target = target,
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = state_dir or vim.fn.tempname(),
    scope = "combined",
  })
end

-- A work-tree review reports the changed post-image rows, unseen; marking the
-- file seen flips exactly those rows.
do
  local s = open(glean.WORKTREE)
  local st = s:file_status("f.txt")
  h.assert_true("worktree: projection present", st ~= nil)
  h.assert_eq("worktree: edited line is a change row", st[2] and st[2].kind, "change")
  h.assert_eq("worktree: edited line unseen", st[2] and st[2].seen, false)
  h.assert_eq("worktree: four is an add row", st[4] and st[4].kind, "add")
  h.assert_eq("worktree: five is an add row", st[5] and st[5].kind, "add")
  h.assert_true("worktree: context untouched", st[1] == nil and st[3] == nil)

  local header
  for row = 0, api.nvim_buf_line_count(s.buf) - 1 do
    local t = s.row_map[row]
    if t and t.cfile and not t.hunk then
      local line = api.nvim_buf_get_lines(s.buf, row, row + 1, false)[1]
      if line and line:find("f.txt", 1, true) then header = row break end
    end
  end
  h.assert_true("worktree: found file header row", header ~= nil)
  s:toggle_seen(header)
  st = s:file_status("f.txt")
  -- Line 5 ("five") is uncommitted, so it is seen only if the worktree
  -- identity's flattened ordinal resolved against the stored block record.
  for _, lnum in ipairs({ 2, 4, 5 }) do
    h.assert_eq("worktree: lnum " .. lnum .. " seen after mark", st[lnum].seen, true)
  end

  h.assert_true("worktree: unknown path is nil", s:file_status("nope.txt") == nil)
end

-- A commit-targeted session paints nothing: its post-image is a snapshot the
-- buffer may have moved past.
do
  local s = open(repo.shas[2])
  h.assert_true("commit target: nil", s:file_status("f.txt") == nil)
end

h.finish()
