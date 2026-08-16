-- Tier 1 tests for glean.comments (pure projections + resolution). Run with:
--   nvim -l nvim/lua/glean/comments_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local comments = require("glean.comments")
local h = require("glean.testutil").new()

local mixed = {
  lnum = 4,
  content = {
    { text = "kept", kind = "context" },
    { text = "removed", kind = "del", old_lnum = 9 },
    { text = "added", kind = "add" },
  },
  text = "note",
}
local delonly = {
  lnum = 4,
  content = { { text = "removed", kind = "del", old_lnum = 9 } },
  text = "note",
}

-- The two projections of one selection: the diff sees every line, the file only
-- the lines that still exist in the post-image.
do
  h.assert_eq("diff projection", table.concat(comments.diff_projection(mixed), "|"),
    "kept|removed|added")
  h.assert_eq("file projection drops deletions",
    table.concat(comments.file_projection(mixed), "|"), "kept|added")
  h.assert_eq("file projection of a del-only record is empty",
    #comments.file_projection(delonly), 0)
end

-- locate against a diff: the whole selection must match, and the resolved lnum
-- comes from the mapping, not from the record.
do
  local lines = { "before", "kept", "removed", "added", "after" }
  local lnums = { 3, 4, 4, 5, 6 }
  local lnum_of = function(i) return lnums[i] end
  local hit = comments.locate(mixed, lines, lnum_of)
  h.assert_eq("locate: diff match index", hit.index, 2)
  h.assert_eq("locate: diff match lnum", hit.lnum, 4)
  h.assert_true("locate: diff match not outdated", hit.outdated == false)
end

-- locate against a plain file: only the surviving lines are searched, and the
-- default mapping is the identity (a buffer position is its own line).
do
  local file = { "prelude", "kept", "added", "tail" }
  local hit = comments.locate(mixed, file, nil, "file")
  h.assert_eq("locate: file match lnum", hit.lnum, 2)
  h.assert_true("locate: file match not outdated", hit.outdated == false)
end

-- Matching is all-or-nothing: one changed line inside the run makes the whole
-- record outdated, falling back to the slot nearest its lnum hint.
do
  local file = { "prelude", "kept", "rewritten", "tail" }
  local hit = comments.locate(mixed, file, nil, "file")
  h.assert_true("locate: partial match is outdated", hit.outdated == true)
  h.assert_eq("locate: fallback nearest the lnum hint", hit.lnum, 4)
  local short = comments.locate(mixed, { "a", "b" }, nil, "file")
  h.assert_eq("locate: fallback clamps to the last line", short.lnum, 2)
end

-- A del-only record has nothing to find in a file, so it is always outdated
-- there while still resolving in the diff.
do
  local file = { "removed" }
  h.assert_true("locate: del-only outdated in a file",
    comments.locate(delonly, file, nil, "file").outdated == true)
  h.assert_true("locate: del-only anchors in a diff",
    comments.locate(delonly, { "removed" }, nil).outdated == false)
end

h.finish()
