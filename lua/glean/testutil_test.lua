-- Tests for glean.testutil.make_repo's history-shaping spec keys. Run with:
--   nvim -l lua/glean/testutil_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local testutil = require("glean.testutil")
local h = testutil.new()

local repo = testutil.make_repo({
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n", ["g.txt"] = "g\n" } },
  { msg = "rename", rename = { ["f.txt"] = "sub/r.txt" } },
  { msg = "delete", delete = { "g.txt" } },
  { msg = "empty", empty = true },
  { msg = "side", branch = "side", files = { ["s.txt"] = "s\n" } },
  { msg = "merge side", merge = "side" },
})

h.assert_eq("one sha per spec entry", #repo.shas, 6)

local function name_status(sha)
  return repo.run({ "show", "--name-status", "--format=", "-M", sha })
end

h.assert_true("rename recorded", name_status(repo.shas[2]):match("^R%d*\tf.txt\tsub/r.txt$") ~= nil,
  name_status(repo.shas[2]))
h.assert_eq("delete recorded", name_status(repo.shas[3]), "D\tg.txt")
h.assert_eq("empty commit touches nothing", name_status(repo.shas[4]), "")
h.assert_eq("branch commit adds file", name_status(repo.shas[5]), "A\ts.txt")

local function parents(sha)
  local out = repo.run({ "rev-list", "--parents", "-n", "1", sha })
  local ps = {}
  for w in out:gmatch("%S+") do ps[#ps + 1] = w end
  table.remove(ps, 1)
  return ps
end

h.assert_eq("empty commit has one parent", #parents(repo.shas[4]), 1)
h.assert_eq("branch commit parent is previous commit", parents(repo.shas[5])[1], repo.shas[4])
h.assert_eq("side branch tip", repo.run({ "rev-parse", "side" }), repo.shas[5])

local mp = parents(repo.shas[6])
h.assert_eq("merge has two parents", #mp, 2)
h.assert_eq("merge first parent is main line", mp[1], repo.shas[4])
h.assert_eq("merge second parent is side", mp[2], repo.shas[5])
h.assert_eq("merge is main tip", repo.run({ "rev-parse", "main" }), repo.shas[6])
h.assert_eq("main excludes side commit",
  repo.run({ "rev-list", "--first-parent", "--count", "main" }), "5")

h.finish()
