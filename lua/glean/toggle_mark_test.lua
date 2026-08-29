-- Tests for Session:toggle_marks — the file-buffer inverse of the gutter
-- projection behind `:Glean toggle-mark`.
-- Run with:
--   nvim -l lua/glean/toggle_mark_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()

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

local function open()
  return glean.open({
    base = repo.shas[1],
    target = glean.WORKTREE,
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = vim.fn.tempname(),
    scope = "combined",
  })
end

-- A row range marks exactly the rows it covers, and re-running it on a fully
-- seen selection unmarks (toggle polarity).
do
  local s = open()
  h.assert_true("range marks", s:toggle_marks("f.txt", 4, 5) == true)
  local st = s:file_status("f.txt")
  h.assert_eq("row 4 seen", st[4].seen, true)
  h.assert_eq("row 5 seen", st[5].seen, true)
  h.assert_eq("row 2 untouched", st[2].seen, false)

  h.assert_true("all-seen range unmarks", s:toggle_marks("f.txt", 4, 5) == true)
  st = s:file_status("f.txt")
  h.assert_eq("row 4 unseen again", st[4].seen, false)
  h.assert_eq("row 5 unseen again", st[5].seen, false)
end

-- A partially seen selection completes rather than flips.
do
  local s = open()
  h.assert_true("mark row 4", s:toggle_marks("f.txt", 4, 4) == true)
  h.assert_true("mark rows 4-5", s:toggle_marks("f.txt", 4, 5) == true)
  local st = s:file_status("f.txt")
  h.assert_eq("partial completes: row 4", st[4].seen, true)
  h.assert_eq("partial completes: row 5", st[5].seen, true)
end

-- No range: the cursor row widens to every line of its hunk. Rows 2..5 sit in
-- one hunk here, so marking from row 2 marks the change and both adds.
do
  local s = open()
  h.assert_true("hunk expansion", s:toggle_marks("f.txt", 2, 2, true) == true)
  local st = s:file_status("f.txt")
  for _, lnum in ipairs({ 2, 4, 5 }) do
    h.assert_eq("hunk expansion: row " .. lnum, st[lnum].seen, true)
  end
end

-- Context rows and unknown paths are inert, with a reason.
do
  local s = open()
  local ok, err = s:toggle_marks("f.txt", 3, 3)
  h.assert_eq("context row is inert", ok, false)
  h.assert_true("context row reason", err ~= nil)
  ok, err = s:toggle_marks("nope.txt", 1, 1)
  h.assert_eq("unknown path is inert", ok, false)
  h.assert_true("unknown path reason", err ~= nil)
end

h.finish()
