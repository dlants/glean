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
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n", ["d.txt"] = "a\nb\nc\nd\ne\n" } },
  { msg = "c1", files = { ["f.txt"] = "one\ntwo\nthree\nfour\n" } },
})
do
  local f = assert(io.open(repo.root .. "/f.txt", "w"))
  f:write("one\ntwo more\nthree\nfour\nfive\n")
  f:close()
end

-- d.txt loses two lines in the work tree and gains none: every changed line is
-- an uncommitted deletion, folded onto a neighbouring post-image row.
do
  local f = assert(io.open(repo.root .. "/d.txt", "w"))
  f:write("a\nd\ne\n")
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

-- A file whose blame provenance has not landed yet is inert: every line would
-- report unowned, so acting would silently mark nothing.
do
  local s = open()
  s:load_lineage()
  s.load_lineage = function(self) return self._owner end
  s._owner["f.txt"].status = "pending"
  local ok, err = s:toggle_marks("f.txt", 4, 5)
  h.assert_eq("pending ownership is inert", ok, false)
  h.assert_eq("pending ownership reason", err, "ownership still loading")
end

-- The stale-buffer guard: the work tree the diff was built from, versus what a
-- (possibly modified) buffer holds.
do
  local s = open()
  local wt = vim.fn.readfile(repo.root .. "/f.txt")
  h.assert_eq("work-tree content matches", s:wt_matches("f.txt", wt), true)
  local edited = vim.deepcopy(wt)
  edited[2] = edited[2] .. " edited"
  h.assert_eq("edited buffer is stale", s:wt_matches("f.txt", edited), false)
  h.assert_eq("shorter buffer is stale", s:wt_matches("f.txt", { wt[1] }), false)
  h.assert_eq("unknown path is stale", s:wt_matches("nope.txt", {}), false)
end

-- Uncommitted deletions, marked from the file buffer. d.txt drops head lines
-- 2 and 3 ("b", "c"), which fold onto post-image row 1. Marking that row must
-- name the same head lines the review buffer names, and the model must then
-- report them seen — the property that broke when del-seen-ness was derived by
-- re-diffing the reviewed baseline.
do
  local s = open()
  local st = s:file_status("d.txt")
  h.assert_eq("deletion folds onto row 1", st[1].del_below, true)
  h.assert_eq("deleted row starts unseen", st[1].seen, false)

  h.assert_true("marking the del row", s:toggle_marks("d.txt", 1, 1) == true)
  for _, lnum in ipairs({ 2, 3 }) do
    local id = require("glean.state").wt_identity("d.txt", lnum, "del")
    h.assert_eq("head line " .. lnum .. " seen", s:id_seen(id), true)
  end
  h.assert_eq("del row reads seen", s:file_status("d.txt")[1].seen, true)

  -- Explicit head-line ranges, not an implicit hole in the reviewed baseline.
  local v = s:wt_versions("d.txt")
  h.assert_eq("dels recorded", vim.inspect(v.dels), vim.inspect({ { 2, 3 } }))
  h.assert_eq("baseline stays head-identical", vim.inspect(v.reviewed), vim.inspect(v.head))

  h.assert_true("unmarking the del row", s:toggle_marks("d.txt", 1, 1) == true)
  h.assert_eq("del row unseen again", s:file_status("d.txt")[1].seen, false)
  h.assert_eq("dels cleared", #s:wt_versions("d.txt").dels, 0)
end

-- A window id outlives the buffer it showed: after the review window is reused
-- for an ordinary file, a render triggered from that file (the gutter marking
-- path) must not restore the review's cursor row into it.
do
  local s = open()
  local other = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(other, 0, -1, false, vim.fn["repeat"]({ "x" }, 40))
  local win = vim.api.nvim_get_current_win()
  s.win = win
  vim.api.nvim_win_set_buf(win, other)
  vim.api.nvim_win_set_cursor(win, { 37, 0 })
  s:render()
  h.assert_eq("foreign window cursor untouched", vim.api.nvim_win_get_cursor(win)[1], 37)
end

-- End to end, through `M.toggle_mark` and a real file buffer: edit a reviewed
-- file while the review buffer is hidden (so the session is suspended), write
-- it, and mark the edited row. The write has to reconcile the model even
-- though nothing is polling for the hidden review; before it did not, so the
-- stale-buffer guard rejected every attempt forever.
do
  local s = open()
  glean.setup({})
  local fbuf = vim.fn.bufadd(repo.root .. "/f.txt")
  vim.fn.bufload(fbuf)
  vim.api.nvim_win_set_buf(0, fbuf)
  s:suspend()

  vim.api.nvim_buf_set_lines(fbuf, 4, 5, false, { "five edited" })
  vim.cmd("silent write")

  vim.wait(5000, function()
    return s:wt_matches("f.txt", vim.api.nvim_buf_get_lines(fbuf, 0, -1, false))
  end, 20)
  h.assert_eq("the write reconciled the model",
    s:wt_matches("f.txt", vim.api.nvim_buf_get_lines(fbuf, 0, -1, false)), true)

  vim.api.nvim_win_set_cursor(0, { 5, 0 })
  glean.toggle_mark(5, 5)
  h.assert_eq("the edited row marks seen", s:file_status("f.txt")[5].seen, true)
end

h.finish()
