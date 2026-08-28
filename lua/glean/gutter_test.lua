-- Tier 1 tests for glean.gutter's pure projection.
-- Run with: nvim -l lua/glean/gutter_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local gutter = require("glean.gutter")
local h = require("glean.testutil").new()

-- Build a hunk from a compact spec: { "<marker><text>", ... } with markers
-- " " context, "+" add, "-" del, starting at post-image line `start`.
local function hunk(start, spec)
  local lines = {}
  local new_lnum = start
  for _, s in ipairs(spec) do
    local marker, text = s:sub(1, 1), s:sub(2)
    if marker == "+" then
      lines[#lines + 1] = { kind = "add", text = text, new_lnum = new_lnum }
      new_lnum = new_lnum + 1
    elseif marker == "-" then
      lines[#lines + 1] = { kind = "del", text = text, new_lnum = new_lnum }
    else
      lines[#lines + 1] = { kind = "context", text = text, new_lnum = new_lnum }
      new_lnum = new_lnum + 1
    end
  end
  return { lines = lines }
end

local function unseen()
  return function() return false end
end

-- Render the map to a sorted, comparable string.
local function dump(marks)
  local lnums = {}
  for lnum in pairs(marks) do
    lnums[#lnums + 1] = lnum
  end
  table.sort(lnums)
  local parts = {}
  for _, lnum in ipairs(lnums) do
    local m = marks[lnum]
    local flags = {}
    if m.del_above then flags[#flags + 1] = "^" end
    if m.del_below then flags[#flags + 1] = "v" end
    if m.seen then flags[#flags + 1] = "S" end
    parts[#parts + 1] = ("%d:%s%s"):format(lnum, m.kind or "-", table.concat(flags, ""))
  end
  return table.concat(parts, " ")
end

-- A pure addition run marks each added lnum, and no context row.
do
  local marks = gutter.project({ hunk(1, { " a", "+b", "+c", " d" }) }, unseen())
  h.assert_eq("pure add", dump(marks), "2:add 3:add")
end

-- A del run immediately followed by a similar add run reads as a change.
do
  local marks = gutter.project({ hunk(1, { " a", "-local x = 1", "+local x = 2", " d" }) }, unseen())
  h.assert_eq("del+add -> change", dump(marks), "2:change")
end

-- 3 dels, 1 similar add: the paired row is a change and carries the tick for the
-- two dels pair_lines left unpaired.
do
  local marks = gutter.project({
    hunk(1, { " a", "-local x = 1", "-alpha beta gamma", "-delta epsilon zeta", "+local x = 2", " d" }),
  }, unseen())
  h.assert_eq("3 del / 1 add", dump(marks), "2:changev")
end

-- Wholly dissimilar del and add runs stay an add row plus a deletion tick.
do
  local marks = gutter.project({ hunk(1, { " a", "-alpha beta gamma", "+zzz(999)", " d" }) }, unseen())
  h.assert_eq("dissimilar", dump(marks), "2:addv")
end

-- A trailing del run with no adds ticks the preceding context row.
do
  local marks = gutter.project({ hunk(1, { " a", " b", "-c", " d" }) }, unseen())
  h.assert_eq("trailing del", dump(marks), "2:-v")
end

-- A deletion at the top of the file ticks row 1 as del_above.
do
  local marks = gutter.project({ hunk(1, { "-a", " b" }) }, unseen())
  h.assert_eq("del at top", dump(marks), "1:-^")
end

-- A change row whose add is seen but whose paired del is not is unseen.
do
  local hunks = { hunk(1, { " a", "-local x = 1", "+local x = 2", " d" }) }
  local marks = gutter.project(hunks, function(dl) return dl.kind == "add" end)
  h.assert_eq("half-marked change", dump(marks), "2:change")
  local both = gutter.project(hunks, function() return true end)
  h.assert_eq("fully marked change", dump(both), "2:changeS")
end

-- A row carrying an unpaired deletion is seen only when the deletion is too.
do
  local hunks = { hunk(1, { " a", " b", "-c", " d" }) }
  local seen_ctx = gutter.project(hunks, function(dl) return dl.kind == "context" end)
  h.assert_eq("unseen deletion tick", dump(seen_ctx), "2:-v")
  local all = gutter.project(hunks, function() return true end)
  h.assert_eq("seen deletion tick", dump(all), "2:-vS")
end

-- Two hunks in one file project into the same map without collision.
do
  local marks = gutter.project({
    hunk(1, { " a", "+b", " c" }),
    hunk(20, { " x", "+y", " z" }),
  }, unseen())
  h.assert_eq("two hunks", dump(marks), "2:add 21:add")
end

-- ── Rendering and lifecycle ─────────────────────────────────────────────────
local api = vim.api
local glean = require("glean.init")
local testutil = require("glean.testutil")
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
gutter.setup({})
local session = glean.open({
  base = repo.shas[1],
  target = glean.WORKTREE,
  repo_root = repo.root,
  run = inject_run,
  open_window = false,
  state_dir = vim.fn.tempname(),
  scope = "combined",
})
vim.cmd("edit " .. vim.fn.fnameescape(repo.root .. "/f.txt"))
local fbuf = api.nvim_get_current_buf()
-- Extmarks in the gutter namespace as "lnum:sign_hl_group", sorted.
local function signs(bufnr)
  local ns = api.nvim_create_namespace("glean_gutter")
  local out = {}
  for _, m in ipairs(api.nvim_buf_get_extmarks(bufnr, ns, 0, -1, { details = true })) do
    out[#out + 1] = ("%d:%s"):format(m[2] + 1, m[4].sign_hl_group)
  end
  table.sort(out)
  return table.concat(out, " ")
end
gutter.refresh(fbuf)
h.assert_eq("painted rows", signs(fbuf),
  "2:GleanGutterChange 4:GleanGutterAdd 5:GleanGutterAdd")
-- Marking the file seen and firing the event repaints in place, in the seen
-- highlight.
local header
for row = 0, api.nvim_buf_line_count(session.buf) - 1 do
  local t = session.row_map[row]
  if t and t.cfile and not t.hunk then
    local line = api.nvim_buf_get_lines(session.buf, row, row + 1, false)[1]
    if line and line:find("f.txt", 1, true) then header = row break end
  end
end
h.assert_true("found file header row", header ~= nil)
session:toggle_seen(header)
api.nvim_exec_autocmds("User", { pattern = "GleanReviewChanged", data = {} })
h.assert_eq("seen rows", signs(fbuf),
  "2:GleanGutterChangeSeen 4:GleanGutterAddSeen 5:GleanGutterAddSeen")
-- An edited buffer has diverged from the model, so it carries no marks.
api.nvim_buf_set_lines(fbuf, 0, 1, false, { "ONE" })
gutter.refresh(fbuf)
h.assert_eq("modified buffer cleared", signs(fbuf), "")
vim.cmd("silent edit!")
gutter.refresh(fbuf)
h.assert_true("repainted after revert", signs(fbuf) ~= "")
-- A buffer outside the session's file set is untouched.
local other = api.nvim_create_buf(true, false)
api.nvim_buf_set_name(other, repo.root .. "/absent.txt")
api.nvim_buf_set_lines(other, 0, -1, false, { "x" })
gutter.refresh(other)
h.assert_eq("unknown file untouched", signs(other), "")
-- Closing the review clears every painted buffer.
glean.close_current()
h.assert_eq("cleared on close", signs(fbuf), "")

h.finish("gutter")
