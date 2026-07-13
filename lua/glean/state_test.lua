-- Tier 1 tests for glean.state: pure range math plus JSON shard round-trips in
-- a tempname() dir. Run with:
--   nvim -l nvim/lua/glean/state_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local state = require("glean.state")
local testutil = require("glean.testutil")
local h = testutil.new()

local function range_str(ranges)
  local parts = {}
  for _, r in ipairs(ranges) do
    parts[#parts + 1] = r[1] .. "-" .. r[2]
  end
  return table.concat(parts, ",")
end

-- merge: overlapping and adjacent ranges coalesce; disjoint stay split.
do
  h.assert_eq("merge: adjacent", range_str(state.merge({ { 1, 3 }, { 4, 6 } })), "1-6")
  h.assert_eq("merge: overlap", range_str(state.merge({ { 1, 5 }, { 3, 8 } })), "1-8")
  h.assert_eq("merge: disjoint", range_str(state.merge({ { 5, 6 }, { 1, 2 } })), "1-2,5-6")
end

-- add / remove.
do
  local r = state.add({ { 1, 2 } }, { 5, 6 })
  h.assert_eq("add: disjoint", range_str(r), "1-2,5-6")
  r = state.add(r, { 3, 4 })
  h.assert_eq("add: bridges", range_str(r), "1-6")
  r = state.remove(r, { 3, 3 })
  h.assert_eq("remove: splits", range_str(r), "1-2,4-6")
  r = state.remove({ { 1, 10 } }, { 1, 10 })
  h.assert_eq("remove: whole", range_str(r), "")
end

-- covers / range_covered.
do
  local r = { { 1, 3 }, { 7, 9 } }
  h.assert_true("covers: inside", state.covers(r, 8))
  h.assert_true("covers: gap", not state.covers(r, 5))
  h.assert_true("range_covered: full", state.range_covered({ { 1, 10 } }, { 3, 7 }))
  h.assert_true("range_covered: split fails", not state.range_covered({ { 1, 4 }, { 6, 10 } }, { 3, 7 }))
end

-- Shard round-trip: seen ranges and stacked comments persist per-sha; load of a
-- never-seen sha is empty; unmatched commit loads clean.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ "shaA", "shaB" })
  s:mark_seen("shaA", "f.txt", { 2, 4 })
  s:mark_seen("shaA", "f.txt", { 10, 10 })
  s:add_comment("shaA", "f.txt", 3, "first")
  s:add_comment("shaA", "f.txt", 3, "second")
  s:add_comment("shaA", "f.txt", 7, "other")
  s:save_commit("shaA")

  local s2 = state.new({ dir = dir })
  s2:load({ "shaA", "shaB" })
  h.assert_eq("roundtrip: seen ranges", range_str(s2:seen_ranges("shaA", "f.txt")), "2-4,10-10")
  local c = s2:comments_at("shaA", "f.txt", 3)
  h.assert_eq("roundtrip: comment count", #c, 2)
  h.assert_eq("roundtrip: comment text", c[1].text, "first")
  h.assert_eq("roundtrip: stacked text", c[2].text, "second")
  h.assert_eq("roundtrip: other line", s2:comments_at("shaA", "f.txt", 7)[1].text, "other")
  h.assert_eq("roundtrip: unseen sha empty", range_str(s2:seen_ranges("shaB", "f.txt")), "")
  h.assert_eq("roundtrip: unmatched lnum empty", #s2:comments_at("shaA", "f.txt", 999), 0)
end

-- Worktree seen-blocks: stored as { anchor, content } records, re-anchored
-- positionally via M.resolve against the live diff (one closest match), so a
-- trivial single-line block marks exactly one ordinal, never file-wide.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:add_seen_record("f.txt", { anchor = 2, content = { "beta", "gamma" } })
  local recs = s:seen_records("f.txt")
  h.assert_eq("seen-block: stored one record", #recs, 1)
  h.assert_eq("seen-block: content preserved", recs[1].content[2], "gamma")

  -- resolve finds the closest single occurrence of a trivial block.
  local diff = { "alpha", "}", "beta", "}", "gamma" }
  h.assert_eq("seen-block: trivial resolves to closest one", state.resolve({ "}" }, 4, diff), 4)

  -- set_seen_records replaces; an empty list prunes the path entry.
  s:set_seen_records("f.txt", {})
  h.assert_eq("seen-block: cleared", #s:seen_records("f.txt"), 0)
end

-- Committed deletion ranges round-trip through save/load, parallel to add ranges.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ "shaA" })
  s:mark_seen("shaA", "f.txt", { 2, 4 })
  s:mark_seen_del("shaA", "f.txt", { 7, 9 })
  s:save_commit("shaA")

  local s2 = state.new({ dir = dir })
  s2:load({ "shaA" })
  h.assert_eq("del roundtrip: add ranges", range_str(s2:seen_ranges("shaA", "f.txt")), "2-4")
  h.assert_eq("del roundtrip: del ranges", range_str(s2:seen_del_ranges("shaA", "f.txt")), "7-9")
end

-- Unified identity API: mark then unmark returns the shard to identical JSON.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  local empty = vim.json.encode(s:commit("shaA"))
  local ids = {
    state.add_identity("shaA", "f.txt", 2),
    state.add_identity("shaA", "f.txt", 3),
    state.del_identity("shaA", "f.txt", 9),
  }
  s:mark(ids)
  h.assert_true("identity: all seen after mark", s:all_seen(ids))
  s:unmark(ids)
  h.assert_true("identity: none seen after unmark", not s:is_seen(ids[1]))
  h.assert_eq("identity: mark+unmark restores JSON", vim.json.encode(s:commit("shaA")), empty)
end

-- Worktree shard round-trips: seen-block records and worktree comments persist
-- through save/reload under the worktree shard.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ "WORKTREE" })
  s:add_seen_record("f.txt", { anchor = 2, content = { "two", "three" } })
  s:wt_add_comment("WORKTREE", "f.txt", "four", "hi")
  s:save_commit("WORKTREE")

  local s2 = state.new({ dir = dir })
  s2:load({ "WORKTREE" })
  local recs = s2:seen_records("f.txt")
  h.assert_eq("wt roundtrip: one seen-block", #recs, 1)
  h.assert_eq("wt roundtrip: block anchor", recs[1].anchor, 2)
  h.assert_eq("wt roundtrip: block content", recs[1].content[2], "three")
  h.assert_eq("wt roundtrip: comment", s2:wt_comments_for("WORKTREE", "f.txt", "four")[1].text, "hi")
end

-- Content-addressed comments: single- and multi-line records round-trip through
-- save/reload; remove drops exactly one; the comments shard loads even when its
-- id is not among the review's seen shas.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ "shaA" })
  s:add_comment_record("f.txt", { anchor = 3, content = { "two" }, text = "single" })
  s:add_comment_record("f.txt", { anchor = 5, content = { "a", "b" }, text = "multi" })
  s:save_commit(state.COMMENTS_ID)

  -- Reload a committed-range review that does NOT list the comments shard id.
  local s2 = state.new({ dir = dir })
  s2:load({ "shaA", "shaB" })
  local list = s2:comments_for("f.txt")
  h.assert_eq("comments: count after reload", #list, 2)
  h.assert_eq("comments: single content", list[1].content[1], "two")
  h.assert_eq("comments: single text", list[1].text, "single")
  h.assert_eq("comments: multi content len", #list[2].content, 2)
  h.assert_eq("comments: multi second line", list[2].content[2], "b")
  h.assert_eq("comments: multi anchor", list[2].anchor, 5)

  -- remove drops exactly one record (matched by anchor/content/text).
  s2:remove_comment_record("f.txt", { anchor = 3, content = { "two" }, text = "single" })
  local after = s2:comments_for("f.txt")
  h.assert_eq("comments: count after remove", #after, 1)
  h.assert_eq("comments: survivor", after[1].text, "multi")

  -- unknown path is empty.
  h.assert_eq("comments: empty path", #s2:comments_for("other.txt"), 0)
end

-- Resolution helper: closest consecutive block match.
do
  local diff = { "alpha", "beta", "gamma", "beta", "delta" }
  -- single occurrence resolves to its index.
  h.assert_eq("resolve: single occurrence", state.resolve({ "gamma" }, 1, diff), 3)
  -- multiple occurrences resolve to the one closest to anchor.
  h.assert_eq("resolve: closest to anchor (low)", state.resolve({ "beta" }, 1, diff), 2)
  h.assert_eq("resolve: closest to anchor (high)", state.resolve({ "beta" }, 5, diff), 4)
  -- tie on distance picks the lower index.
  h.assert_eq("resolve: tie picks lower", state.resolve({ "beta" }, 3, diff), 2)
  -- multi-line block matches only when consecutive.
  h.assert_eq("resolve: consecutive block", state.resolve({ "alpha", "beta" }, 1, diff), 1)
  h.assert_eq("resolve: non-consecutive nil", state.resolve({ "alpha", "gamma" }, 1, diff), nil)
  -- a deletion's text present in diff_texts resolves; absent content is nil.
  local withdel = { "ctx", "-removed", "ctx2" }
  h.assert_eq("resolve: deletion text", state.resolve({ "-removed" }, 2, withdel), 2)
  h.assert_eq("resolve: absent content nil", state.resolve({ "missing" }, 1, diff), nil)
  -- empty content is nil.
  h.assert_eq("resolve: empty content nil", state.resolve({}, 1, diff), nil)
end
-- Seen-block records round-trip on the worktree shard, and a mark fully undone
-- (set to empty) restores the shard JSON byte-identically.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ state.COMMENTS_ID })
  local empty = vim.json.encode(s.data[state.COMMENTS_ID] or { files = {} })
  s:add_seen_record("old.txt", { anchor = 1, content = { "fresh" } })
  s:save_commit(state.COMMENTS_ID)
  local s2 = state.new({ dir = dir })
  s2:load({ state.COMMENTS_ID })
  h.assert_eq("seen-block roundtrip: persists on reload",
    s2:seen_records("old.txt")[1].content[1], "fresh")

  -- Undo the mark: the slice prunes back to byte-identical JSON.
  s:set_seen_records("old.txt", {})
  h.assert_eq("seen-block: mark+unmark restores JSON",
    vim.json.encode(s.data[state.COMMENTS_ID] or { files = {} }), empty)
end

-- Stage 2 — branch-anchored worktree shard. The store routes all
-- content-addressed (kind="wt") seen/comment access through `wt_shard`, so a mark
-- made on branch A's shard is invisible when the same identity is queried under
-- branch B's shard, while round-tripping within A. Branch names containing "/"
-- map to a single safe shard file.
do
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  local rec = { anchor = 1, content = { "line" } }

  local a = state.new({ dir = dir, wt_shard = "WORKTREE/feature/a" })
  a:load({})
  a:add_seen_record("w.txt", rec)
  a:save_commit(a.wt_shard)
  h.assert_eq("wt_shard: seen-block under A", #a:seen_records("w.txt"), 1)

  -- The branch-with-slash shard maps to a single readable file.
  h.assert_eq("wt_shard: slash-safe filename readable",
    vim.fn.filereadable(a:shard_path("WORKTREE/feature/a")), 1)

  local b = state.new({ dir = dir, wt_shard = "WORKTREE/feature/b" })
  b:load({})
  h.assert_eq("wt_shard: absent under B", #b:seen_records("w.txt"), 0)

  -- Reopening A's shard still has the block; B's load left A's file untouched.
  local a2 = state.new({ dir = dir, wt_shard = "WORKTREE/feature/a" })
  a2:load({})
  h.assert_eq("wt_shard: A persists on reload", #a2:seen_records("w.txt"), 1)
end

-- Stage 2 — comments exhibit the same branch isolation as seen-marks.
do
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  local rec = { anchor = 1, content = { "x" }, text = "hi" }

  local a = state.new({ dir = dir, wt_shard = "WORKTREE/a" })
  a:load({})
  a:add_comment_record("c.txt", rec)
  a:save_commit(a.wt_shard)
  h.assert_eq("wt_shard comments: present under A", #a:comments_for("c.txt"), 1)

  local b = state.new({ dir = dir, wt_shard = "WORKTREE/b" })
  b:load({})
  h.assert_eq("wt_shard comments: absent under B", #b:comments_for("c.txt"), 0)
end

-- Sticky seen-overrides: content-addressed under the worktree shard, round-trip
-- on reload, self-invalidate on content change, and prune to byte-identical JSON
-- when removed.
do
  local dir = vim.fn.tempname()
  local s = state.new({ dir = dir })
  s:load({ state.COMMENTS_ID })
  local empty = vim.json.encode(s.data[state.COMMENTS_ID] or { files = {} })

  s:add_sticky("s.txt", "A1")
  h.assert_true("sticky: recorded line is sticky", s:is_sticky("s.txt", "A1"))
  h.assert_true("sticky: other content not sticky", not s:is_sticky("s.txt", "A1x"))
  h.assert_true("sticky: other path not sticky", not s:is_sticky("o.txt", "A1"))

  s:save_commit(state.COMMENTS_ID)
  local s2 = state.new({ dir = dir })
  s2:load({ state.COMMENTS_ID })
  h.assert_true("sticky: persists on reload", s2:is_sticky("s.txt", "A1"))

  -- Removing the sticky mark prunes the slice back to byte-identical JSON.
  s:remove_sticky("s.txt", "A1")
  h.assert_true("sticky: removed no longer sticky", not s:is_sticky("s.txt", "A1"))
  h.assert_eq("sticky: add+remove restores JSON",
    vim.json.encode(s.data[state.COMMENTS_ID] or { files = {} }), empty)
end

h.finish()
