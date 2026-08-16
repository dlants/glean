-- Tier 3a tests for glean.api: the programmatic surface over a live review.
-- Run with:
--   nvim -l lua/glean/api_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local glean = require("glean.init")
local gapi = require("glean.api")
local testutil = require("glean.testutil")
local h = testutil.new()
local vapi = vim.api
local function make(spec)
  local repo = testutil.make_repo(spec)
  local function run(args)
    local cmd = { "git" }
    for _, a in ipairs(args) do cmd[#cmd + 1] = a end
    local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
    return { code = res.code, stdout = res.stdout, stderr = res.stderr }
  end
  return repo, run
end
local repo, run = make({
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n" } },
  { msg = "c1", files = { ["f.txt"] = "one\nTWO\nthree\n", ["g.txt"] = "gee\n" } },
})
local base, target = repo.shas[1], repo.shas[2]
local state_dir = vim.fn.tempname()
local function open(o)
  o = o or {}
  return glean.open({
    base = o.base or base,
    target = o.target or target,
    repo_root = o.repo_root or repo.root,
    run = o.run or run,
    open_window = false,
    state_dir = o.state_dir or state_dir,
    identifier = o.identifier,
  })
end
local function wipe(s)
  vapi.nvim_buf_delete(s.buf, { force = true })
end
-- No session open: every entry point errors with a message naming the fix.
do
  local ok, err = pcall(gapi.comments)
  h.assert_true("no session: comments errors", not ok)
  h.assert_true("no session: message names the fix",
    tostring(err):find(":Glean", 1, true) ~= nil, tostring(err))
  h.assert_eq("no session: sessions is empty", #gapi.sessions(), 0)
end
-- Listing: comments on two files come back in file/ordinal order with the
-- correct path, line and text; ids appear verbatim in the rendered buffer.
local ids
do
  local s = open()
  s.store:add_comment_record("f.txt", { lnum = 1, content = { { text = "TWO", kind = "add" } }, text = "on two" })
  s.store:add_comment_record("g.txt", { lnum = 1, content = { { text = "gee", kind = "add" } }, text = "on gee" })
  s.store:save_commit(s.store.wt_shard)
  s:render()
  local list = gapi.comments()
  h.assert_eq("list: count", #list, 2)
  h.assert_eq("list: first path", list[1].path, "f.txt")
  h.assert_eq("list: second path", list[2].path, "g.txt")
  h.assert_eq("list: text", list[1].text, "on two")
  h.assert_eq("list: code", list[1].code, "TWO")
  h.assert_eq("list: side", list[1].side, "new")
  h.assert_eq("list: lnum", list[1].lnum, 2)
  h.assert_eq("list: not outdated", list[1].outdated, false)
  h.assert_true("list: unanswered by default", list[1].reply == nil)
  -- path filter
  local only = gapi.comments(nil, { path = "g.txt" })
  h.assert_eq("list: path filter count", #only, 1)
  h.assert_eq("list: path filter path", only[1].path, "g.txt")
  -- ids are stable across repeated calls and appear in the buffer.
  ids = { list[1].id, list[2].id }
  local again = gapi.comments()
  h.assert_eq("list: id stable across calls", again[1].id, ids[1])
  local joined = table.concat(vapi.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
  h.assert_true("list: id rendered in buffer",
    joined:find(("[%d] on two"):format(ids[1]), 1, true) ~= nil)
  -- everything crossing the boundary is JSON-serializable.
  h.assert_true("list: json round-trips",
    vim.json.decode(vim.json.encode(list))[1].text == "on two")
end
-- Unanswered filter, and id stability across a reply and a reopen from the same
-- state dir.
do
  local s = open()
  local before = gapi.comments()
  local rec = vim.tbl_extend("force", s.store:comments_for("f.txt")[1], { path = "f.txt" })
  s:set_comment_reply(rec, "an answer")
  local after = gapi.comments()
  h.assert_eq("reply: id unchanged", after[1].id, before[1].id)
  h.assert_eq("reply: reply surfaced", after[1].reply, "an answer")
  local unanswered = gapi.comments(nil, { unanswered = true })
  h.assert_eq("unanswered: count", #unanswered, 1)
  h.assert_eq("unanswered: is the g.txt one", unanswered[1].path, "g.txt")
  s:refresh_model()
  h.assert_eq("refresh: id stable", gapi.comments()[1].id, ids[1])
  wipe(s)
  local reopened = open()
  h.assert_eq("reopen: id stable", gapi.comments()[1].id, ids[1])
  h.assert_true("reopen: fresh session id", reopened.id ~= nil)
  wipe(reopened)
end
-- Outdated: a comment whose anchored content is nowhere in the diff.
do
  local s = open()
  s.store:add_comment_record("f.txt",
    { lnum = 1, content = { { text = "NOT IN THE DIFF", kind = "add" } }, text = "stale" })
  s.store:save_commit(s.store.wt_shard)
  local list = gapi.comments(nil, { path = "f.txt" })
  local stale
  for _, c in ipairs(list) do if c.text == "stale" then stale = c end end
  h.assert_true("outdated: present", stale ~= nil)
  h.assert_eq("outdated: flagged", stale and stale.outdated, true)
  wipe(s)
end
-- Buffer naming: a review of two full oids abbreviates them to 8 chars while
-- `buffer_key` (reuse of the same buffer) still keys on the full oids; a
-- symbolic identifier is left alone.
do
  local s = open()
  local name = vapi.nvim_buf_get_name(s.buf)
  h.assert_true("title: carries the session id",
    name:find("Glean:" .. s.id .. " ", 1, true) ~= nil, name)
  h.assert_true("title: abbreviates full oids",
    name:find(base:sub(1, 8) .. ".." .. target:sub(1, 8), 1, true) ~= nil, name)
  h.assert_true("title: full oids absent", name:find(base, 1, true) == nil, name)
  local again = open()
  h.assert_eq("title: reopen reuses the buffer", again.buf, s.buf)
  h.assert_eq("title: reopen keeps the id", again.id, s.id)
  local sym = open({ identifier = "feature/x" })
  local sym_name = vapi.nvim_buf_get_name(sym.buf)
  h.assert_true("title: symbolic ref untouched",
    sym_name:find("feature∕x", 1, true) ~= nil, sym_name)
  wipe(sym)
end
-- Two sessions on different repos get distinct ids and each resolves by its id;
-- an ambiguous call lists both candidates, an unknown id errors.
do
  local a = open()
  local repo2, run2 = make({
    { msg = "base", files = { ["z.txt"] = "z\n" } },
    { msg = "c1", files = { ["z.txt"] = "Z\n" } },
  })
  local b = glean.open({
    base = repo2.shas[1], target = repo2.shas[2], repo_root = repo2.root,
    run = run2, open_window = false, state_dir = vim.fn.tempname(),
  })
  h.assert_true("multi: distinct ids", a.id ~= b.id)
  h.assert_eq("multi: sessions listed", #gapi.sessions(), 2)
  h.assert_eq("multi: resolves by id", gapi.session(b.id).git.repo_root, repo2.root)
  h.assert_eq("multi: resolves by buffer", gapi.session(a.buf).id, a.id)
  h.assert_eq("multi: b has no comments", #gapi.comments(b.id), 0)
  local ok, err = pcall(gapi.comments)
  h.assert_true("multi: ambiguous errors", not ok)
  h.assert_true("multi: error lists both",
    tostring(err):find(a.id, 1, true) and tostring(err):find(b.id, 1, true) ~= nil,
    tostring(err))
  h.assert_true("multi: error names the repo",
    tostring(err):find(repo2.root, 1, true) ~= nil, tostring(err))
  local ok2, err2 = pcall(gapi.comments, "g999")
  h.assert_true("multi: unknown id errors", not ok2)
  h.assert_true("multi: unknown id message", tostring(err2):find("g999", 1, true) ~= nil)
  wipe(b)
  wipe(a)
end
-- Mutations: reply/unreply by (session, id), undoable, persisted, rendered.
do
  local s = open()
  local target_id = gapi.comments(nil, { path = "g.txt" })[1].id
  local before = gapi.comments(nil, { path = "g.txt" })[1]
  gapi.reply(nil, target_id, "agent says hi")
  local after = gapi.comments(nil, { path = "g.txt" })[1]
  h.assert_eq("reply: surfaced", after.reply, "agent says hi")
  h.assert_eq("reply: text untouched", after.text, before.text)
  h.assert_eq("reply: id untouched", after.id, before.id)
  local joined = table.concat(vapi.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
  h.assert_true("reply: rendered in the buffer",
    joined:find("agent says hi", 1, true) ~= nil)

  gapi.reply(nil, target_id, "second answer")
  h.assert_eq("reply: replaces, not accumulates",
    gapi.comments(nil, { path = "g.txt" })[1].reply, "second answer")

  s:undo()
  h.assert_eq("undo: back to the previous reply",
    gapi.comments(nil, { path = "g.txt" })[1].reply, "agent says hi")
  s:undo()
  h.assert_true("undo: back to unanswered",
    gapi.comments(nil, { path = "g.txt" })[1].reply == nil)

  gapi.reply(nil, target_id, "final answer")
  gapi.unreply(nil, target_id)
  h.assert_true("unreply: cleared",
    gapi.comments(nil, { path = "g.txt" })[1].reply == nil)
  gapi.reply(nil, target_id, "final answer")

  local ok, err = pcall(gapi.reply, nil, 99999, "nope")
  h.assert_true("reply: unknown id errors", not ok)
  h.assert_true("reply: unknown id message",
    tostring(err):find("99999", 1, true) ~= nil, tostring(err))
  local ok2 = pcall(gapi.reply, nil, target_id, "")
  h.assert_true("reply: empty text errors", not ok2)

  wipe(s)
  local reopened = open()
  h.assert_eq("reply: persists across reopen",
    gapi.comments(nil, { path = "g.txt" })[1].reply, "final answer")
  wipe(reopened)
end

-- The api can never author or destroy a human comment: reply is the only write.
do
  h.assert_true("surface: no add", gapi.add == nil)
  h.assert_true("surface: no delete", gapi.delete == nil)
  h.assert_true("surface: no remove", gapi.remove == nil)
  h.assert_true("surface: no edit", gapi.edit == nil)
  h.assert_true("surface: reply exists", type(gapi.reply) == "function")
  h.assert_true("surface: unreply exists", type(gapi.unreply) == "function")
end
-- Hunks: enumeration, both modes, glob filtering, paging, and marking.
do
  local hrepo, hrun = make({
    { msg = "base", files = {
      ["lua/a.lua"] = "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n",
      ["b.txt"] = "b1\n",
    } },
    { msg = "c1", files = {
      ["lua/a.lua"] = "A1\na2\na3\na4\na5\na6\na7\na8\na9\nA10\n",
    } },
    { msg = "c2", files = { ["b.txt"] = "B1\n" } },
  })
  local hs = glean.open({
    base = hrepo.shas[1], target = hrepo.shas[3], repo_root = hrepo.root,
    run = hrun, open_window = false, state_dir = vim.fn.tempname(),
  })
  local all = gapi.hunks(hs.id, { limit = 100 })
  h.assert_eq("hunks: combined by default", all.hunks[1].mode, "combined")
  h.assert_eq("hunks: last page has no cursor", all.cursor, nil)
  h.assert_true("hunks: covers both files", all.total >= 3, all.total)
  -- Two edits ten lines apart in one file are two hunks; b.txt is one more.
  local paths = {}
  for _, hk in ipairs(all.hunks) do paths[hk.path] = (paths[hk.path] or 0) + 1 end
  h.assert_eq("hunks: a.lua hunk count", paths["lua/a.lua"], 2)
  h.assert_eq("hunks: b.txt hunk count", paths["b.txt"], 1)
  local first = all.hunks[1]
  h.assert_eq("hunks: ordered by path", first.path, "b.txt")
  h.assert_eq("hunks: header from the diff", first.header:sub(1, 2), "@@")
  h.assert_eq("hunks: new_start", first.new_start, 1)
  h.assert_eq("hunks: adds", first.adds, 1)
  h.assert_eq("hunks: dels", first.dels, 1)
  h.assert_eq("hunks: unseen to start", first.unseen_lines, 2)
  h.assert_eq("hunks: not seen", first.seen, false)
  local del, add
  for _, l in ipairs(first.lines) do
    if l.kind == "del" then del = l elseif l.kind == "add" then add = l end
  end
  h.assert_eq("lines: del text", del.text, "b1")
  h.assert_eq("lines: del side", del.side, "old")
  h.assert_eq("lines: add text", add.text, "B1")
  h.assert_eq("lines: add side", add.side, "new")
  h.assert_eq("lines: add lnum", add.lnum, 1)
  h.assert_eq("lines: unseen to start", add.seen, false)

  -- Commits mode enumerates per commit, on the same (combined-scope) session.
  local byc = gapi.hunks(hs.id, { mode = "commits", limit = 100 })
  h.assert_eq("commits mode: mode echoed", byc.hunks[1].mode, "commits")
  h.assert_eq("commits mode: first commit is c1", byc.hunks[1].sha, hrepo.shas[2])
  h.assert_eq("commits mode: first path", byc.hunks[1].path, "lua/a.lua")
  local last = byc.hunks[#byc.hunks]
  h.assert_eq("commits mode: last commit is c2", last.sha, hrepo.shas[3])
  h.assert_eq("commits mode: last path", last.path, "b.txt")

  -- Glob filtering.
  h.assert_eq("glob: nested match", gapi.hunks(hs.id, { path = "lua/**/*.lua", limit = 100 }).total, 2)
  h.assert_eq("glob: flat glob misses nested",
    gapi.hunks(hs.id, { path = "*.txt", limit = 100 }).total, 1)
  h.assert_eq("glob: no match", gapi.hunks(hs.id, { path = "*.rs" }).total, 0)

  -- Paging: following the cursor one hunk at a time reproduces the full list.
  local walked, cursor, guard = {}, nil, 0
  repeat
    local page = gapi.hunks(hs.id, { limit = 1, cursor = cursor })
    for _, hk in ipairs(page.hunks) do walked[#walked + 1] = hk.id end
    cursor = page.cursor
    guard = guard + 1
  until cursor == nil or guard > 20
  h.assert_eq("paging: same count", #walked, #all.hunks)
  for i, hk in ipairs(all.hunks) do
    h.assert_eq("paging: same order " .. i, walked[i], hk.id)
  end

  -- Partial mark: one line of a hunk, not the hunk.
  local target = gapi.hunks(hs.id, { path = "lua/**/*.lua", limit = 100 }).hunks[1]
  local line_i
  for _, l in ipairs(target.lines) do if l.kind == "add" then line_i = l.i end end
  local res = gapi.mark(hs.id, { id = target.id, lines = { line_i } })
  h.assert_eq("partial: one line changed", res.lines, 1)
  local after = gapi.hunks(hs.id, { path = "lua/**/*.lua", limit = 100 }).hunks[1]
  h.assert_eq("partial: hunk still unseen", after.seen, false)
  h.assert_eq("partial: unseen count drops", after.unseen_lines, target.unseen_lines - 1)
  local marked
  for _, l in ipairs(after.lines) do if l.i == line_i then marked = l end end
  h.assert_eq("partial: that line is seen", marked.seen, true)
  local body = table.concat(vapi.nvim_buf_get_lines(hs.buf, 0, -1, false), "\n")
  h.assert_true("partial: rendered as a marked run", body:find("marked", 1, true) ~= nil, body)
  hs:undo()
  h.assert_eq("partial: undone",
    gapi.hunks(hs.id, { path = "lua/**/*.lua", limit = 100 }).hunks[1].unseen_lines,
    target.unseen_lines)

  -- Whole-hunk mark, batched: one undo step for both hunks.
  local both = gapi.hunks(hs.id, { path = "lua/**/*.lua", limit = 100 }).hunks
  local batch = gapi.mark(hs.id, { both[1].id, both[2].id })
  h.assert_eq("mark: hunks applied", batch.hunks, 2)
  h.assert_eq("mark: both now seen",
    gapi.hunks(hs.id, { path = "lua/**/*.lua", seen = true, limit = 100 }).total, 2)
  h.assert_eq("mark: none unseen",
    gapi.hunks(hs.id, { path = "lua/**/*.lua", seen = false, limit = 100 }).total, 0)
  hs:undo()
  h.assert_eq("mark: one undo reverts the batch",
    gapi.hunks(hs.id, { path = "lua/**/*.lua", seen = true, limit = 100 }).total, 0)

  -- Unmark round-trips to the starting rendered state.
  local before_body = table.concat(vapi.nvim_buf_get_lines(hs.buf, 0, -1, false), "\n")
  gapi.mark(hs.id, both[1].id)
  h.assert_eq("mark: re-marking flips no lines", gapi.mark(hs.id, both[1].id).lines, 0)
  gapi.mark(hs.id, both[1].id, false)
  h.assert_eq("unmark: back to the starting render",
    table.concat(vapi.nvim_buf_get_lines(hs.buf, 0, -1, false), "\n"), before_body)

  -- Errors name the offending id / index / mode.
  local ok, err = pcall(gapi.mark, hs.id, "b:000099:000001")
  h.assert_true("mark: unknown id errors", not ok)
  h.assert_true("mark: unknown id message",
    tostring(err):find("b:000099:000001", 1, true) ~= nil, tostring(err))
  local ok2, err2 = pcall(gapi.mark, hs.id, { id = both[1].id, lines = { 999 } })
  h.assert_true("mark: bad line index errors", not ok2)
  h.assert_true("mark: bad line index message",
    tostring(err2):find("999", 1, true) ~= nil, tostring(err2))
  local ok3, err3 = pcall(gapi.hunks, hs.id, { mode = "nope" })
  h.assert_true("hunks: bad mode errors", not ok3)
  h.assert_true("hunks: bad mode message",
    tostring(err3):find("nope", 1, true) ~= nil, tostring(err3))
  wipe(hs)
end

h.finish()
