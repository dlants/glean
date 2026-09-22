-- Regenerates lua-store/ from the Lua implementation. Run from the repo root:
--   rm -rf node/core/fixtures/lua-store && nvim -l node/core/fixtures/generate-lua-store.lua
package.path = "lua/?.lua;lua/?/init.lua;" .. package.path
local state = require("glean.state")
local dir = "node/core/fixtures/lua-store"
local s = state.new({ dir = dir, wt_shard = "WORKTREE/feature/x" })
s:load({ "aaaa" })
s:mark_seen("aaaa", "f.txt", { 2, 4 })
s:mark_seen("aaaa", "f.txt", { 10, 10 })
s:mark_seen_del("aaaa", "f.txt", { 7, 9 })
s:mark_seen("aaaa", "g.txt", { 1, 1 })
s:save_commit("aaaa")
local hb = state.content_hash({ "a", "b", "c" })
s:set_baseline("w.txt", hb, { "a", "B", "b", "c" }, { { 2, 2 } })
s:set_baseline("d.txt", hb, nil, { { 1, 1 }, { 3, 3 } })
s:add_sticky("s.txt", "A1")
s:add_comment_record("f.txt", { lnum = 7, content = {
  { text = "kept", kind = "context" }, { text = "removed", kind = "del", old_lnum = 42 },
  { text = "added", kind = "add" } }, text = "mixed", origin = { sha = "abc123", dirty = true } })
s:add_comment_record("f.txt", { lnum = 3, content = { { text = "two", kind = "add" } }, text = "single" })
s:set_comment_reply("f.txt", { id = 2 }, "an answer")
s:save_commit(s.wt_shard)
-- A legacy shard: no ids, legacy seen hash lists, seen_marks.
vim.fn.writefile({ vim.json.encode({
  worktree = true,
  files = { ["f.txt"] = { seen = { { head = 1, hash = "x", n = 1 } }, comments = {} } },
  seen_marks = { ["f.txt"] = { { anchor = 1, content = { "one" } } } },
  sticky = { ["f.txt"] = { [state.line_hash("one")] = true } },
  comments = {
    ["b.txt"] = { { lnum = 1, content = { { text = "x", kind = "add" } }, text = "bee" } },
    ["a.txt"] = {
      { lnum = 1, content = { { text = "y", kind = "add" } }, text = "one" },
      { anchor = 2, content = { "z" }, text = "two" },
    },
  },
}) }, dir .. "/WORKTREE.json")
-- (end)
