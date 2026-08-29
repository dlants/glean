-- Tier 1 tests for glean.ignore (pure .gleanignore matcher).
-- Run with: nvim -l lua/glean/ignore_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local ignore = require("glean.ignore")
local h = require("glean.testutil").new()
-- Assert a matcher's verdict on a batch of paths.
local function check(label, text, cases)
  local m = ignore.compile(text)
  for path, want in pairs(cases) do
    h.assert_eq(("%s: %s"):format(label, path), m:match(path), want)
  end
end
check("bare name matches at any depth", "*.pb.go\n", {
  ["api.pb.go"] = true,
  ["src/gen/api.pb.go"] = true,
  ["src/api.go"] = false,
})
check("interior slash anchors at the root", "gen/*.ts\n", {
  ["gen/api.ts"] = true,
  ["src/gen/api.ts"] = false,
})
check("leading slash anchors too", "/dist\n", {
  ["dist"] = true,
  ["dist/app.js"] = true,
  ["sub/dist"] = false,
})
check("directory-only rule ignores the subtree", "build/\n", {
  ["build/out.js"] = true,
  ["src/build/out.js"] = true,
  ["build"] = false,
})
check("last matching rule wins", "*.lock\n!Cargo.lock\n", {
  ["yarn.lock"] = true,
  ["Cargo.lock"] = false,
})
check("an ignored directory cannot be re-included from within", "gen/\n!gen/keep.ts\n", {
  ["gen/keep.ts"] = true,
})
check("double star spans directories", "src/**/snap/*.json\n", {
  ["src/snap/a.json"] = true,
  ["src/a/b/snap/a.json"] = true,
  ["other/snap/a.json"] = false,
})
check("trailing double star matches the subtree", "vendor/**\n", {
  ["vendor/a/b.go"] = true,
  ["vendor"] = false,
})
check("single star does not cross a slash", "gen/*.go\n", {
  ["gen/a.go"] = true,
  ["gen/sub/a.go"] = false,
})
check("comments and blanks are not rules", "# *.go\n\n*.js\n", {
  ["a.go"] = false,
  ["a.js"] = true,
})
check("character classes and ? are supported", "snap?/[ab].txt\n", {
  ["snap1/a.txt"] = true,
  ["snap1/c.txt"] = false,
})
check("dots are literal", "a.b\n", {
  ["a.b"] = true,
  ["axb"] = false,
})
h.assert_eq("ruleless text compiles to nil", ignore.compile("\n# only a comment\n"), nil)
h.finish()
