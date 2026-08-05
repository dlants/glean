-- Directory grouping: files render nested under one row per directory
-- component; `=` on a directory row collapses everything beneath it and `m`
-- marks/unmarks every file under it. Run with:
--   nvim -l lua/glean/dirtree_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

-- Pure layout ---------------------------------------------------------------
local dir_layout = glean._internal.dir_layout

do
  local l = dir_layout({ "top.txt", "a/one.txt", "a/b/two.txt", "c/three.txt" })
  local shape = {}
  for _, n in ipairs(l) do
    shape[#shape + 1] = ("%s:%d:%s"):format(n.kind, n.depth, n.name)
  end
  h.assert_eq("layout: preorder shape",
    table.concat(shape, " "),
    "file:0:top.txt dir:0:a file:1:one.txt file:1:b/two.txt file:0:c/three.txt")
  h.assert_eq("layout: dir prefix is the full path", l[2].prefix, "a")
  h.assert_eq("layout: dir covers nested files", #l[2].files, 2)
end

do
  -- A chain of single-child directories renders as one row.
  local l = dir_layout({ "a/b/c/one.txt", "a/b/c/two.txt" })
  h.assert_eq("layout: chain collapses into one dir row", #l, 3)
  h.assert_eq("layout: collapsed dir name", l[1].name, "a/b/c")
  h.assert_eq("layout: collapsed dir keeps the deepest prefix", l[1].prefix, "a/b/c")
  h.assert_eq("layout: files sit one level under the collapsed dir", l[2].depth, 1)
  h.assert_eq("layout: collapsed dir still covers every file", #l[1].files, 2)

  -- A chain bottoming out at a lone file needs no dir row at all.
  local single = dir_layout({ "a/b/c/one.txt" })
  h.assert_eq("layout: lone file collapses to a single row", #single, 1)
  h.assert_eq("layout: lone file shows its full path", single[1].name, "a/b/c/one.txt")
  h.assert_eq("layout: lone file sits at depth 0", single[1].depth, 0)

  -- A branching directory stops the chain.
  local branch = dir_layout({ "a/b/one.txt", "a/x/two.txt" })
  local shape = {}
  for _, n in ipairs(branch) do shape[#shape + 1] = n.kind .. ":" .. n.name end
  h.assert_eq("layout: chain stops at a branching directory",
    table.concat(shape, " "), "dir:a file:b/one.txt file:x/two.txt")
end

do
  -- A directory that reappears after an unrelated path opens a second row.
  local l = dir_layout({ "a/one.txt", "a/two.txt", "z/x.txt", "z/y.txt",
    "a/three.txt", "a/four.txt" })
  local dirs = 0
  for _, n in ipairs(l) do if n.kind == "dir" then dirs = dirs + 1 end end
  h.assert_eq("layout: unsorted input reopens a directory", dirs, 3)
end

-- Rendering / actions -------------------------------------------------------
local repo = testutil.make_repo({
  { msg = "base", files = {
    ["root.txt"] = "r\n",
    ["src/a.txt"] = "a1\na2\n",
    ["src/deep/b.txt"] = "b\n",
    ["src/deep/c.txt"] = "c\n",
  } },
  { msg = "edit all", files = {
    ["root.txt"] = "R\n",
    ["src/a.txt"] = "A1\nA2\n",
    ["src/deep/b.txt"] = "B\n",
    ["src/deep/c.txt"] = "C\n",
  } },
})

local function inject_run(args)
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

local function open(scope)
  return glean.open({
    base = repo.shas[1],
    target = repo.shas[2],
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = vim.fn.tempname(),
    scope = scope,
  })
end

local function buftext(s)
  return table.concat(api.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
end

-- Whether any / all changed lines under `prefix` are seen, read back through
-- the same identity path the action layer uses.
local function seen_state(s, prefix)
  local row
  for r, t in pairs(s.row_map) do
    if t.dir == prefix then row = r end
  end
  local ids = s:target_identities(s.row_map[row])
  local any = false
  for _, id in ipairs(ids) do
    if s:id_seen(id) then any = true end
  end
  return { any = any, all = #ids > 0 and s:ids_all_seen(ids) }
end

local function dir_row(s, prefix)
  for row, t in pairs(s.row_map) do
    if t.dir == prefix then return row end
  end
end

for _, scope in ipairs({ "combined", "commits" }) do
  local label = "[" .. scope .. "] "
  do
    local s = open(scope)
    local text = buftext(s)
    h.assert_true(label .. "render: src/ directory row", text:find("▼ .*src/") ~= nil)
    h.assert_true(label .. "render: nested deep/ row indented", text:find("\n  ▼ .*deep/") ~= nil)
    h.assert_true(label .. "render: file row shows its full path",
      text:find("src/a.txt", 1, true) ~= nil)
    h.assert_true(label .. "render: root file stays at depth 0", text:find("\n▼ .*root%.txt") ~= nil)
  end

  do
    local s = open(scope)
    local before = buftext(s)
    h.assert_true(label .. "collapse: b body visible before", before:find("\n+B", 1, true) ~= nil)
    s:toggle_collapse(dir_row(s, "src"))
    local after = buftext(s)
    h.assert_true(label .. "collapse: src/ closed chevron", after:find("▶ .*src/") ~= nil)
    h.assert_true(label .. "collapse: nested dir hidden", after:find("deep/") == nil)
    h.assert_true(label .. "collapse: files under src hidden", after:find("a%.txt") == nil)
    h.assert_true(label .. "collapse: sibling root file intact", after:find("root.txt", 1, true) ~= nil)
    s:toggle_collapse(dir_row(s, "src"))
    h.assert_eq(label .. "collapse: re-expand restores the buffer", buftext(s), before)
  end

  do
    local s = open(scope)
    h.assert_true(label .. "mark: nothing seen initially", not seen_state(s, "src").any)
    s:toggle_seen(dir_row(s, "src"))
    h.assert_true(label .. "mark: both files under src/ marked seen", seen_state(s, "src").all)
    h.assert_true(label .. "mark: seen header is indented beneath its file",
      buftext(s):find("\n    ▶ seen (1 hunks)", 1, true) ~= nil)
    h.assert_true(label .. "mark: root.txt untouched",
      buftext(s):find("\n+R", 1, true) ~= nil)
    s:toggle_seen(dir_row(s, "src"))
    h.assert_true(label .. "mark: re-mark unmarks the whole directory",
      not seen_state(s, "src").any)
  end

  do
    -- A partially seen directory marks (rather than unmarks) the remainder.
    local s = open(scope)
    s:toggle_seen(dir_row(s, "src/deep"))
    s:toggle_seen(dir_row(s, "src"))
    h.assert_true(label .. "mark: partial directory marks the rest", seen_state(s, "src").all)
  end
end

-- Collapsed-row summaries ---------------------------------------------------
for _, scope in ipairs({ "combined", "commits" }) do
  local label = "[" .. scope .. "] "
  local function line_at(s, row)
    return api.nvim_buf_get_lines(s.buf, row, row + 1, false)[1]
  end

  do
    local s = open(scope)
    h.assert_true(label .. "summary: expanded directory shows no tally",
      not line_at(s, dir_row(s, "src")):find("unseen"))
    s:toggle_collapse(dir_row(s, "src"))
    h.assert_true(label .. "summary: collapsed directory tallies every hunk under it",
      line_at(s, dir_row(s, "src")):find("(0 seen / 3 unseen)", 1, true) ~= nil)
    -- Collapse overrides live in process memory keyed by the review, so a test
    -- that leaves src/ folded would leak into the next session.
    s:toggle_collapse(dir_row(s, "src"))
  end

  do
    local s = open(scope)
    s:toggle_seen(dir_row(s, "src/deep"))
    s:toggle_collapse(dir_row(s, "src"))
    h.assert_true(label .. "summary: seen hunks move to the seen side",
      line_at(s, dir_row(s, "src")):find("(2 seen / 1 unseen)", 1, true) ~= nil)
    s:toggle_collapse(dir_row(s, "src"))
  end

  do
    -- A collapsed file header carries the same tally.
    local s = open(scope)
    local frow
    for r, t in pairs(s.row_map) do
      if (t.file or t.cfile) and not t.hunk and not t.line
        and line_at(s, r):find("root%.txt") then frow = r end
    end
    s:toggle_collapse(frow)
    h.assert_true(label .. "summary: collapsed file tallies its own hunks",
      line_at(s, frow):find("(0 seen / 1 unseen)", 1, true) ~= nil)
    s:toggle_collapse(frow)
  end

  do
    -- A hunk with only some of its lines marked still reads as unseen.
    local s = open(scope)
    -- src/a.txt's single hunk changes two lines; mark just the first.
    local hrow
    for r, t in pairs(s.row_map) do
      if t.line and line_at(s, r):find("A1", 1, true) then hrow = r end
    end
    s:mark_visual_range(hrow, hrow)
    s:toggle_collapse(dir_row(s, "src"))
    h.assert_true(label .. "summary: a partially marked hunk counts as unseen",
      line_at(s, dir_row(s, "src")):find("(0 seen / 3 unseen)", 1, true) ~= nil)
    s:toggle_collapse(dir_row(s, "src"))
  end
end

-- Full paths / sticky header ------------------------------------------------
local function text_at(s, row)
  return api.nvim_buf_get_lines(s.buf, row, row + 1, false)[1]
end

local function file_row(s, name)
  for r, t in pairs(s.row_map) do
    if (t.file or t.cfile) and not t.hunk and not t.line then
      local line = text_at(s, r)
      if line:find(name, 1, true) then return r, line end
    end
  end
end

for _, scope in ipairs({ "combined", "commits" }) do
  local s = open(scope)
  local label = "[" .. scope .. "] "

  local _, nested = file_row(s, "b.txt")
  h.assert_true(label .. "file row shows the full path",
    nested:find("src/deep/b.txt", 1, true) ~= nil)
  h.assert_true(label .. "file row stays indented under its directory",
    nested:find("^%s") ~= nil)

  local _, root = file_row(s, "root.txt")
  h.assert_true(label .. "root-level file is unchanged",
    root:find("root.txt", 1, true) ~= nil and root:find("/") == nil)

  h.assert_true(label .. "dir row shows its full prefix",
    text_at(s, dir_row(s, "src/deep")):find("src/deep/", 1, true) ~= nil)
end

do
  -- A single-child chain must not double up its prefix.
  local chain = testutil.make_repo({
    { msg = "base", files = { ["a/b/c/one.txt"] = "x\n" } },
    { msg = "edit", files = { ["a/b/c/one.txt"] = "y\n" } },
  })
  local s = glean.open({
    base = chain.shas[1],
    target = chain.shas[2],
    repo_root = chain.root,
    scope = "combined",
    state_dir = vim.fn.tempname(),
    run = function(args)
      local cmd = { "git" }
      for _, a in ipairs(args) do cmd[#cmd + 1] = a end
      local res = vim.system(cmd, { cwd = chain.root, env = chain.env, text = true }):wait()
      return { code = res.code, stdout = res.stdout, stderr = res.stderr }
    end,
  })
  local line
  for r, t in pairs(s.row_map) do
    if t.cfile and not t.hunk and not t.line then line = text_at(s, r) end
  end
  h.assert_true("chain: lone file renders its path exactly once",
    line:find("a/b/c/one.txt", 1, true) ~= nil
    and line:find("a/b/c/a/b/c", 1, true) == nil)
end


h.finish()
