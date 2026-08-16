-- Tier 3 tests for glean.overlay: comments rendered into ordinary file buffers.
-- Driven through real `:edit`/`:write`/`:checktime` against a hermetic repo, so
-- the autocmd wiring is exercised rather than bypassed. Run with:
--   nvim -l nvim/lua/glean/overlay_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local overlay = require("glean.overlay")
local comments = require("glean.comments")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

local repo = testutil.make_repo({
  { msg = "base", files = {
    ["f.txt"] = "alpha\nbeta\ngamma\n",
    ["multi.txt"] = "one\ntwo\nthree\nfour\n",
    ["quiet.txt"] = "nothing here\n",
  } },
})
local ctx = comments.register(repo.root, vim.fn.tempname(), "WORKTREE/main")
local function store() return comments.store(ctx) end
overlay.setup()
vim.o.autoread = true

-- Records are written through the registry store, the same object the overlay
-- reads, so a test never holds a stale handle.
local function add(path, record)
  comments.store(ctx):add_comment_record(path, record)
  comments.persist(ctx, path)
end

local function entry(text, kind, old_lnum)
  return { text = text, kind = kind or "add", old_lnum = old_lnum }
end

local function edit(path)
  vim.cmd("edit! " .. repo.root .. "/" .. path)
  return api.nvim_get_current_buf()
end

local function marks(buf)
  return api.nvim_buf_get_extmarks(buf, api.nvim_create_namespace("glean_overlay"), 0, -1,
    { details = true })
end

local function sign_marks(buf)
  local out = {}
  for _, m in ipairs(marks(buf)) do
    if m[4].sign_text then out[#out + 1] = m end
  end
  return out
end

local function write_file(path, content)
  local f = assert(io.open(repo.root .. "/" .. path, "w"))
  f:write(content)
  f:close()
end

-- Records written straight into the store show up on open, as a sign at the
-- resolved line with the body's first line trailing it.
do
  add("f.txt", { lnum = 2, content = { entry("beta") }, text = "why beta?\nsecond line" })
  local buf = edit("f.txt")
  local signs = sign_marks(buf)
  h.assert_eq("open: one sign", #signs, 1)
  h.assert_eq("open: sign on the resolved line", signs[1][2], 1)
  local virt = signs[1][4].virt_text
  h.assert_true("open: eol text is the body's first line",
    virt and virt[1][1]:find("why beta?", 1, true) ~= nil)
  h.assert_true("open: eol text stops at the first line",
    virt[1][1]:find("second line", 1, true) == nil)
end

-- An agent rewriting the file behind the buffer's back: the reload re-resolves
-- the comment and the moved lnum is persisted without the user ever writing.
do
  write_file("f.txt", "prefix\nprefix2\nalpha\nbeta\ngamma\n")
  vim.cmd("checktime")
  local buf = api.nvim_get_current_buf()
  local signs = sign_marks(buf)
  h.assert_eq("external write: re-resolved sign row", signs[1] and signs[1][2], 3)
  h.assert_eq("external write: persisted lnum", store():comments_for("f.txt")[1].lnum, 4)
  local reread = require("glean.state").new({ dir = ctx.dir, wt_shard = ctx.wt_shard })
  reread:load({})
  h.assert_eq("external write: persisted to disk", reread:comments_for("f.txt")[1].lnum, 4)
end

-- The same path through a user edit: inserting lines above and writing moves
-- the comment; a resolve that lands where it already was writes nothing.
do
  local buf = api.nvim_get_current_buf()
  api.nvim_buf_set_lines(buf, 0, 0, false, { "extra" })
  vim.cmd("write")
  h.assert_eq("user edit: persisted lnum", store():comments_for("f.txt")[1].lnum, 5)
  local saves = 0
  local live = store()
  local orig = live.save_commit
  live.save_commit = function(self, ...)
    saves = saves + 1
    return orig(self, ...)
  end
  overlay.refresh(buf)
  h.assert_eq("stable resolve does not write the store", saves, 0)
  live.save_commit = nil
end

-- A selection that mixed added and deleted lines anchors on its surviving
-- lines; a del-only record has no file position at all.
do
  add("multi.txt", { lnum = 2, content = {
    entry("two", "context"), entry("gone", "del", 7), entry("three"),
  }, text = "mixed" })
  add("multi.txt", { lnum = 3, content = { entry("gone", "del", 7) }, text = "del only" })
  local buf = edit("multi.txt")
  local signs = sign_marks(buf)
  h.assert_eq("mixed: exactly one record renders", #signs, 1)
  h.assert_eq("mixed: anchored on the surviving run", signs[1][2], 1)
  local spans = 0
  for _, m in ipairs(marks(buf)) do
    if m[4].line_hl_group then spans = spans + 1 end
  end
  h.assert_eq("mixed: the run's extent is highlighted", spans, 2)
end

-- Deleting the commented text renders the record outdated at its fallback slot,
-- and that position is written back.
do
  local buf = api.nvim_get_current_buf()
  api.nvim_buf_set_lines(buf, 1, 3, false, { "rewritten" })
  vim.cmd("write")
  local signs = sign_marks(buf)
  h.assert_eq("outdated: still one sign", #signs, 1)
  h.assert_true("outdated: labelled",
    signs[1][4].virt_text[1][1]:find("(outdated)", 1, true) ~= nil)
  h.assert_eq("outdated: sign hl", signs[1][4].sign_hl_group, "GleanCommentOutdated")
  h.assert_eq("outdated: fallback lnum persisted",
    store():comments_for("multi.txt")[1].lnum, signs[1][2] + 1)
end

-- A file with no comments is untouched: no extmarks at all.
do
  local buf = edit("quiet.txt")
  h.assert_eq("uncommented file: no extmarks", #marks(buf), 0)
end

-- The float shows the whole body and the agent's reply; the inline toggle adds
-- and removes virt_lines without disturbing the signs.
do
  local buf = edit("f.txt")
  local record = store():comments_for("f.txt")[1]
  store():set_comment_reply("f.txt", record, "agent says hi")
  local win = overlay.show(buf, record.lnum)
  h.assert_true("float: opened", win ~= nil and api.nvim_win_is_valid(win))
  local text = table.concat(api.nvim_buf_get_lines(api.nvim_win_get_buf(win), 0, -1, false), "\n")
  h.assert_true("float: full body", text:find("second line", 1, true) ~= nil)
  h.assert_true("float: reply", text:find("agent says hi", 1, true) ~= nil)
  api.nvim_win_close(win, true)
  h.assert_true("float: none for an uncommented line", overlay.show(buf, 1) == nil)

  h.assert_eq("toggle: on", overlay.toggle(buf), true)
  local inline_marks = 0
  for _, m in ipairs(marks(buf)) do
    if m[4].virt_lines then inline_marks = inline_marks + 1 end
  end
  h.assert_true("toggle: inline bodies present", inline_marks > 0)
  h.assert_eq("toggle: signs survive", #sign_marks(buf), 1)
  overlay.toggle(buf)
  local still_inline = 0
  for _, m in ipairs(marks(buf)) do
    if m[4].virt_lines then still_inline = still_inline + 1 end
  end
  h.assert_eq("toggle: inline bodies removed", still_inline, 0)
  h.assert_eq("toggle: signs still there", #sign_marks(buf), 1)
end

-- The quickfix dump covers every comment in the repo, including the del-only
-- record that has no file position.
do
  local items = overlay.quickfix(ctx)
  h.assert_eq("quickfix: one item per record", #items, 3)
  local joined = ""
  for _, item in ipairs(items) do joined = joined .. item.filename .. " " .. item.text .. "\n" end
  h.assert_true("quickfix: names the files",
    joined:find("f.txt", 1, true) ~= nil and joined:find("multi.txt", 1, true) ~= nil)
  h.assert_true("quickfix: marks the del-only record outdated",
    joined:find("del only (outdated)", 1, true) ~= nil)
end

h.finish()
