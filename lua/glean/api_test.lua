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
  s.store:add_comment_record("f.txt", { anchor = 1, content = { "TWO" }, text = "on two" })
  s.store:add_comment_record("g.txt", { anchor = 1, content = { "gee" }, text = "on gee" })
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
    { anchor = 1, content = { "NOT IN THE DIFF" }, text = "stale" })
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
-- The api is read-only in this stage: no mutating entry points are exposed.
do
  h.assert_true("surface: no add", gapi.add == nil)
  h.assert_true("surface: no delete", gapi.delete == nil)
end
h.finish()
