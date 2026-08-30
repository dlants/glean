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
-- Sources: the coordinates of every diff line folded into a row, so the gutter
-- can be inverted back into diff coordinates.
local function dump_sources(marks, lnum)
  local parts = {}
  for _, s in ipairs(marks[lnum].sources) do
    parts[#parts + 1] = ("%d.%d"):format(s.hunk, s.li)
  end
  return table.concat(parts, " ")
end
do
  local marks = gutter.project({ hunk(1, { " a", "+b", "+c", " d" }) }, unseen())
  h.assert_eq("add sources", dump_sources(marks, 2), "1.2")
  h.assert_eq("add sources 2", dump_sources(marks, 3), "1.3")
end
do
  local marks = gutter.project({ hunk(1, { " a", "-local x = 1", "+local x = 2", " d" }) }, unseen())
  h.assert_eq("change sources pair both lines", dump_sources(marks, 2), "1.3 1.2")
end
do
  local marks = gutter.project({
    hunk(1, { " a", "-local x = 1", "-alpha beta gamma", "-delta epsilon zeta", "+local x = 2", " d" }),
  }, unseen())
  h.assert_eq("unpaired dels attach to the change row", dump_sources(marks, 2), "1.5 1.2 1.3 1.4")
end
do
  local marks = gutter.project({ hunk(1, { "-gone", " a" }) }, unseen())
  h.assert_eq("del_above sources", dump_sources(marks, 1), "1.1")
end
do
  local marks = gutter.project({
    hunk(1, { " a", "+b" }),
    hunk(10, { " x", "+y" }),
  }, unseen())
  h.assert_eq("hunk index is the file's hunk list index", dump_sources(marks, 11), "2.2")
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
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n", ["d.txt"] = "a\nb\nc\nd\ne\n" } },
  { msg = "c1", files = { ["f.txt"] = "one\ntwo\nthree\nfour\n" } },
})
do
  local f = assert(io.open(repo.root .. "/f.txt", "w"))
  f:write("one\ntwo more\nthree\nfour\nfive\n")
  f:close()
end

-- d.txt only loses lines in the work tree, so its glyph is a deletion mark.
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

-- An uncommitted deletion's glyph follows the same seen model the review buffer
-- reads: marking the row it folds onto flips it to the seen highlight, and
-- unmarking flips it back.
do
  vim.cmd("edit " .. vim.fn.fnameescape(repo.root .. "/d.txt"))
  local dbuf = api.nvim_get_current_buf()
  gutter.refresh(dbuf)
  h.assert_eq("deletion glyph", signs(dbuf), "1:GleanGutterDelete")
  h.assert_true("marked the deletion", session:toggle_marks("d.txt", 1, 1) == true)
  gutter.refresh(dbuf)
  h.assert_eq("deletion glyph seen", signs(dbuf), "1:GleanGutterDeleteSeen")
  h.assert_true("unmarked the deletion", session:toggle_marks("d.txt", 1, 1) == true)
  gutter.refresh(dbuf)
  h.assert_eq("deletion glyph unseen again", signs(dbuf), "1:GleanGutterDelete")
  vim.cmd("buffer " .. fbuf)
end
-- A buffer outside the session's file set is untouched.
local other = api.nvim_create_buf(true, false)
api.nvim_buf_set_name(other, repo.root .. "/absent.txt")
api.nvim_buf_set_lines(other, 0, -1, false, { "x" })
gutter.refresh(other)
h.assert_eq("unknown file untouched", signs(other), "")
-- ── Per-buffer toggle ───────────────────────────────────────────────────────
gutter.refresh(fbuf)
h.assert_true("painted before toggle", signs(fbuf) ~= "")
h.assert_eq("toggle off returns false", gutter.toggle(fbuf), false)
h.assert_eq("toggle clears the buffer", signs(fbuf), "")
gutter.refresh(fbuf)
h.assert_eq("a toggled-off buffer stays clear across refreshes", signs(fbuf), "")
h.assert_eq("toggle on returns true", gutter.toggle(fbuf), true)
h.assert_true("toggle repaints", signs(fbuf) ~= "")

-- ── Foreign provider suppression ────────────────────────────────────────────
local calls = {} --- @type string[]
local fake = {
  detach = function(b) calls[#calls + 1] = "detach:" .. b end,
  attach = function(b) calls[#calls + 1] = "attach:" .. b end,
}
gutter.setup({ suppress = fake })
gutter.clear_all() -- drop the "auto" provider's bookkeeping from the paints above
calls = {}
gutter.refresh(fbuf)
gutter.refresh(fbuf)
h.assert_eq("detached once", table.concat(calls, " "), "detach:" .. fbuf)
gutter.refresh(other)
h.assert_eq("untouched buffer not detached", table.concat(calls, " "), "detach:" .. fbuf)
gutter.clear_all()
h.assert_eq("reattached on teardown", table.concat(calls, " "),
  ("detach:%d attach:%d"):format(fbuf, fbuf))

calls = {}
gutter.setup({ suppress = false })
gutter.refresh(fbuf)
gutter.clear_all()
h.assert_eq("suppress=false never calls the provider", table.concat(calls, " "), "")

gutter.setup({ suppress = { detach = function() error("boom") end, attach = function() end } })
gutter.refresh(fbuf)
h.assert_true("painted despite a throwing provider", signs(fbuf) ~= "")

-- ── Hunk navigation ─────────────────────────────────────────────────────────
local nav_marks = {
  [4] = { sources = { { hunk = 1, li = 2 } } },
  [5] = { sources = { { hunk = 1, li = 3 } } },
  [20] = { sources = { { hunk = 2, li = 1 } } },
}
local starts = gutter.hunk_starts(nav_marks)
h.assert_eq("one start per hunk, ascending", table.concat(starts, ","), "4,20")
h.assert_eq("no marks, no starts", #gutter.hunk_starts({}), 0)
h.assert_eq("next from before the first", gutter.next_hunk_row(starts, 1, 1), 4)
h.assert_eq("next skips the rest of the hunk", gutter.next_hunk_row(starts, 5, 1), 20)
h.assert_eq("next wraps at the end", gutter.next_hunk_row(starts, 20, 1), 4)
h.assert_eq("prev from inside a hunk", gutter.next_hunk_row(starts, 20, -1), 4)
h.assert_eq("prev wraps at the top", gutter.next_hunk_row(starts, 4, -1), 20)
h.assert_eq("nothing to move to", gutter.next_hunk_row({}, 1, 1), nil)

local function has_map(bufnr, mode, lhs)
  for _, m in ipairs(vim.api.nvim_buf_get_keymap(bufnr, mode)) do
    if m.lhs == lhs then return true end
  end
  return false
end
h.assert_true("]c mapped in the reviewed buffer", has_map(fbuf, "n", "]c"))
h.assert_true("gm mapped in visual mode", has_map(fbuf, "x", "gm"))
-- ── `gm` as an operator ─────────────────────────────────────────────────────
-- The maps drive the real operator machinery, so this exercises `operatorfunc`
-- + `'[`/`']` end to end. f.txt's changed work-tree rows are 2, 4 and 5.
do
  gutter.setup({})
  vim.cmd("buffer " .. fbuf)
  api.nvim_win_set_buf(0, fbuf)
  if signs(fbuf):find("Seen") then
    session:toggle_marks("f.txt", 1, api.nvim_buf_line_count(fbuf))
  end
  gutter.refresh(fbuf)
  h.assert_eq("all unseen to start", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAdd 5:GleanGutterAdd")

  api.nvim_win_set_cursor(0, { 4, 0 })
  vim.api.nvim_feedkeys("gmm", "x", false)
  gutter.refresh(fbuf)
  h.assert_eq("gmm marks only its line", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAddSeen 5:GleanGutterAdd")
  h.assert_eq("gmm leaves the cursor put", api.nvim_win_get_cursor(0)[1], 4)

  vim.api.nvim_feedkeys("gmm", "x", false)
  gutter.refresh(fbuf)
  h.assert_eq("gmm toggles back", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAdd 5:GleanGutterAdd")

  api.nvim_win_set_cursor(0, { 2, 0 })
  vim.api.nvim_feedkeys("gm2j", "x", false)
  gutter.refresh(fbuf)
  h.assert_eq("gm2j marks lines 2..4", signs(fbuf),
    "2:GleanGutterChangeSeen 4:GleanGutterAddSeen 5:GleanGutterAdd")
  h.assert_eq("gm2j leaves the cursor at the motion start", api.nvim_win_get_cursor(0)[1], 2)

  vim.api.nvim_feedkeys("gm2j", "x", false)
  gutter.refresh(fbuf)
  h.assert_eq("gm2j toggles back", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAdd 5:GleanGutterAdd")
end

-- ── Marks in the file buffer's undo stack ───────────────────────────────────
-- A mark changes no text, so it rides glean.bufundo on top of the buffer's own
-- undo tree: `u` spends it first and only then steps the text.
do
  local UNSEEN = "2:GleanGutterChange 4:GleanGutterAdd 5:GleanGutterAdd"
  local function feed(keys)
    vim.api.nvim_feedkeys(api.nvim_replace_termcodes(keys, true, false, true), "x", false)
    gutter.refresh(fbuf)
  end
  api.nvim_win_set_cursor(0, { 4, 0 })
  feed("gmm")
  h.assert_eq("marked", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAddSeen 5:GleanGutterAdd")
  api.nvim_win_set_cursor(0, { 1, 0 })
  feed("u")
  h.assert_eq("u reverses the mark", signs(fbuf), UNSEEN)
  h.assert_eq("u parks on the row it unmarked", api.nvim_win_get_cursor(0)[1], 4)
  feed("<C-r>")
  h.assert_eq("<C-r> replays it", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAddSeen 5:GleanGutterAdd")
  feed("u")
  h.assert_eq("the stack is spent", signs(fbuf), UNSEEN)

  -- A novel edit wipes the mark stack: undoing a mark onto lines the user has
  -- since rewritten would name rows that no longer mean what they did.
  feed("gmm")
  vim.bo[fbuf].modifiable = true
  feed("A x<Esc>")
  feed("u")
  h.assert_eq("text undo, and the mark stayed marked", signs(fbuf),
    "2:GleanGutterChange 4:GleanGutterAddSeen 5:GleanGutterAdd")
  feed("gmm")
  h.assert_eq("marking still works after the wipe", signs(fbuf), UNSEEN)
end

-- Closing the review clears every painted buffer.
gutter.setup({ suppress = false })
glean.close_current()
h.assert_eq("cleared on close", signs(fbuf), "")
h.assert_true("maps removed on close", not has_map(fbuf, "n", "]c"))


h.finish("gutter")
