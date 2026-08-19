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

-- ── Authoring from a file buffer ────────────────────────────────────────────

-- A committed file of its own, so authoring is exercised against a clean
-- worktree independent of what the rendering tests above left behind.
write_file("author.txt", "one\ntwo\nthree\nfour\n")
repo.run({ "add", "--", "author.txt" })
repo.run({ "commit", "-q", "-m", "author" })
local head_sha = repo.run({ "rev-parse", "HEAD" })

-- Submit `text` into the ephemeral editor `open` puts on screen.
local function author(open, text)
  open()
  local ebuf = api.nvim_get_current_buf()
  h.assert_eq("editor: scratch buffer", vim.bo[ebuf].buftype, "acwrite")
  api.nvim_buf_set_lines(ebuf, 0, -1, false, vim.split(text, "\n", { plain = true }))
  vim.cmd("write")
end

local function buf_map(buf, lhs)
  for _, m in ipairs(api.nvim_buf_get_keymap(buf, "n")) do
    if m.lhs == lhs then return m end
  end
  return nil
end

-- A buffer with no comments is untouched, right down to `u` still meaning undo.
do
  local buf = edit("quiet.txt")
  h.assert_true("quiet: u is not mapped", buf_map(buf, "u") == nil)
  h.assert_true("quiet: <C-r> is not mapped", buf_map(buf, "<C-R>") == nil)
end

-- Authoring in a file buffer captures post-image lines only, with the buffer's
-- line as the anchor and HEAD as the provenance, persisted to disk.
do
  local buf = edit("author.txt")
  api.nvim_win_set_cursor(0, { 2, 0 })
  author(function() overlay.add_at(buf, 2) end, "about two")
  local record
  for _, r in ipairs(store():comments_for("author.txt")) do
    if r.text == "about two" then record = r end
  end
  h.assert_true("author: record persisted in memory", record ~= nil)
  h.assert_eq("author: anchored at the cursor line", record.lnum, 2)
  h.assert_eq("author: one entry", #record.content, 1)
  h.assert_eq("author: captured the line text", record.content[1].text, "two")
  h.assert_eq("author: file selections are post-image", record.content[1].kind, "add")
  h.assert_eq("author: origin is HEAD", record.origin.sha, head_sha)
  h.assert_eq("author: clean worktree is not dirty", record.origin.dirty, false)
  local reread = require("glean.state").new({ dir = ctx.dir, wt_shard = ctx.wt_shard })
  reread:load({})
  local found = false
  for _, r in ipairs(reread:comments_for("author.txt")) do
    if r.text == "about two" then found = true end
  end
  h.assert_true("author: persisted to disk", found)
  h.assert_true("author: u is mapped once the buffer has comments", buf_map(buf, "u") ~= nil)
end

-- A visual range captures the exact contiguous line texts.
do
  local buf = api.nvim_get_current_buf()
  author(function() overlay.add_range(buf, 3, 4) end, "about the tail")
  local record
  for _, r in ipairs(store():comments_for("author.txt")) do
    if r.text == "about the tail" then record = r end
  end
  h.assert_eq("range: two entries", #record.content, 2)
  h.assert_eq("range: first line", record.content[1].text, "three")
  h.assert_eq("range: second line", record.content[2].text, "four")
  h.assert_eq("range: anchored at the range start", record.lnum, 3)
end

-- With several comments on one line, delete removes exactly the chosen one.
do
  local buf = api.nvim_get_current_buf()
  author(function() overlay.add_at(buf, 2) end, "second on two")
  local before = #store():comments_for("author.txt")
  local select_orig = vim.ui.select
  local prompted
  vim.ui.select = function(choices, opts, cb)
    prompted = #choices
    for i, choice in ipairs(choices) do
      if choice == "second on two" then return cb(choice, i) end
    end
    cb(nil, nil)
  end
  overlay.delete_at(buf, 2)
  vim.ui.select = select_orig
  h.assert_eq("delete: prompted with both comments", prompted, 2)
  local after = store():comments_for("author.txt")
  h.assert_eq("delete: removed exactly one", #after, before - 1)
  local remaining = false
  for _, r in ipairs(after) do
    if r.text == "second on two" then remaining = true end
  end
  h.assert_true("delete: removed the chosen record", not remaining)
end

-- `u` undoes the comment delete without touching the buffer text, then falls
-- through to a real buffer undo once the glean stack is empty; `<C-r>` mirrors.
do
  local buf = api.nvim_get_current_buf()
  local text_before = api.nvim_buf_get_lines(buf, 0, -1, false)
  local seq_before = vim.fn.undotree().seq_last
  h.assert_eq("undo: handled by glean", overlay.undo(buf), true)
  local restored = false
  for _, r in ipairs(store():comments_for("author.txt")) do
    if r.text == "second on two" then restored = true end
  end
  h.assert_true("undo: comment restored", restored)
  h.assert_eq("undo: buffer text untouched",
    table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), "\n"),
    table.concat(text_before, "\n"))
  h.assert_eq("undo: no new undo state", vim.fn.undotree().seq_last, seq_before)

  h.assert_eq("redo: handled by glean", overlay.redo(buf), true)
  local gone = true
  for _, r in ipairs(store():comments_for("author.txt")) do
    if r.text == "second on two" then gone = false end
  end
  h.assert_true("redo: comment removed again", gone)

  -- The glean stack still holds the two authoring actions; drain it, then the
  -- next `u` must be a plain buffer undo.
  overlay.undo(buf)
  overlay.undo(buf)
  overlay.undo(buf)
  api.nvim_buf_set_lines(buf, 0, 0, false, { "typed" })
  h.assert_eq("fallthrough: the edit is in the buffer's tree",
    api.nvim_buf_get_lines(buf, 0, 1, false)[1], "typed")
  h.assert_eq("fallthrough: glean declines", overlay.undo(buf), false)
  h.assert_true("fallthrough: buffer text undone",
    api.nvim_buf_get_lines(buf, 0, 1, false)[1] ~= "typed")
end

-- A novel text edit wipes the comment stack; undoing text does not.
do
  local buf = api.nvim_get_current_buf()
  api.nvim_buf_set_lines(buf, 0, 0, false, { "text first" })
  author(function() overlay.add_at(buf, 1) end, "stack probe")
  local seq = vim.fn.undotree().seq_last
  vim.cmd("undo")
  vim.cmd("redo")
  h.assert_eq("wipe: text undo/redo leaves seq_last alone", vim.fn.undotree().seq_last, seq)
  h.assert_eq("wipe: comment action still undoable", overlay.undo(buf), true)

  author(function() overlay.add_at(buf, 1) end, "wiped probe")
  api.nvim_buf_set_lines(buf, 0, 0, false, { "novel" })
  h.assert_true("wipe: a novel edit bumps seq_last", vim.fn.undotree().seq_last > seq)
  h.assert_eq("wipe: the comment stack is gone", overlay.undo(buf), false)
  local kept = false
  for _, r in ipairs(store():comments_for("author.txt")) do
    if r.text == "wiped probe" then kept = true end
  end
  h.assert_true("wipe: the comment itself survives", kept)
end

-- Undoing an authoring action from the buffer it was authored in: the editor
-- split is the current buffer when the action is performed, so the stack must
-- be keyed to the file buffer's own undo state, not whatever was focused.
do
  write_file("undo.txt", "red\ngreen\nblue\n")
  repo.run({ "add", "--", "undo.txt" })
  repo.run({ "commit", "-q", "-m", "undo" })
  local buf = edit("undo.txt")
  api.nvim_win_set_cursor(0, { 2, 0 })
  author(function() overlay.add_at(buf, 2) end, "about green")
  h.assert_eq("author-undo: rendered", #sign_marks(buf), 1)
  h.assert_eq("author-undo: handled by glean", overlay.undo(buf), true)
  h.assert_eq("author-undo: record removed", #store():comments_for("undo.txt"), 0)
  h.assert_eq("author-undo: sign gone", #sign_marks(buf), 0)
  h.assert_eq("author-undo: redo handled by glean", overlay.redo(buf), true)
  h.assert_eq("author-undo: record back", #store():comments_for("undo.txt"), 1)
  h.assert_eq("author-undo: sign back", #sign_marks(buf), 1)
end

-- Redo replays the undos in reverse order: text edited, then a comment left,
-- undone twice, must redo the text first and the comment second.
do
  local buf = edit("undo.txt")
  api.nvim_buf_set_lines(buf, 0, 0, false, { "typed" })
  author(function() overlay.add_at(buf, 2) end, "about the order")
  local function has_comment()
    for _, r in ipairs(store():comments_for("undo.txt")) do
      if r.text == "about the order" then return true end
    end
    return false
  end
  local function first_line()
    return api.nvim_buf_get_lines(buf, 0, 1, false)[1]
  end
  overlay.undo(buf)
  h.assert_true("order: comment undone first", not has_comment())
  overlay.undo(buf)
  h.assert_true("order: text undone second", first_line() ~= "typed")

  overlay.redo(buf)
  h.assert_eq("order: text redone first", first_line(), "typed")
  h.assert_true("order: comment not back yet", not has_comment())
  overlay.redo(buf)
  h.assert_true("order: comment redone second", has_comment())
end

-- Outside a git repo authoring is a clean no-op with a notification.
do
  local outside = vim.fn.tempname()
  vim.fn.mkdir(outside, "p")
  local f = assert(io.open(outside .. "/loose.txt", "w"))
  f:write("hello\n")
  f:close()
  local notified
  local notify_orig = vim.notify
  vim.notify = function(msg) notified = msg end
  vim.cmd("edit! " .. outside .. "/loose.txt")
  local buf = api.nvim_get_current_buf()
  overlay.add_at(buf, 1)
  vim.notify = notify_orig
  h.assert_true("outside: notified", notified ~= nil and notified:find("git repo", 1, true) ~= nil)
  h.assert_eq("outside: no editor opened", vim.bo[api.nvim_get_current_buf()].buftype, "")
  h.assert_eq("outside: no extmarks", #marks(buf), 0)
end

h.finish()
