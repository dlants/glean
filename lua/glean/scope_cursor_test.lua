-- Tier 3a tests: toggling between the combined and commit-by-commit scopes
-- keeps the cursor on the same physical line. Both scopes derive the same flat
-- line identity for a line, so the cursor survives by identity, degrading to
-- the nearest line in the same file and then to the file header.
--   nvim -l lua/glean/scope_cursor_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

-- a.txt: c1 rewrites l2 -> ALPHA (survives to the tip) and l4 -> TEMP (deleted
-- again by c3); c2 deletes l1 and rewrites l5 -> BETA. b.txt is untouched after
-- its introduction so it exercises a file present in only one commit.
local repo = testutil.make_repo({
  { msg = "base", files = { ["a.txt"] = "l1\nl2\nl3\nl4\nl5\n", ["b.txt"] = "b1\n" } },
  { msg = "c1", files = { ["a.txt"] = "l1\nALPHA\nl3\nTEMP\nl5\n" } },
  { msg = "c2", files = { ["a.txt"] = "ALPHA\nl3\nTEMP\nBETA\n", ["b.txt"] = "B1\n" } },
  { msg = "c3", files = { ["a.txt"] = "ALPHA\nl3\nBETA\n" } },
})
local function inject_run(args)
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end
local function open(scope)
  return glean.open({
    base = repo.shas[1], target = repo.shas[4], repo_root = repo.root, run = inject_run,
    open_window = true, state_dir = vim.fn.tempname(), scope = scope,
  })
end
local function find_row(s, pred)
  for row = 0, api.nvim_buf_line_count(s.buf) - 1 do
    local line = api.nvim_buf_get_lines(s.buf, row, row + 1, false)[1]
    if pred(row, line, s.row_map[row]) then return row, line end
  end
end
local function row_with_text(s, text)
  return find_row(s, function(_, line, t) return t and t.li and line == text end)
end
local function put(s, row) api.nvim_win_set_cursor(s.win, { row + 1, 0 }) end
local function cursor_target(s) return s.row_map[s:cursor_row()] end
local function cursor_path(s)
  local f = s:row_file(cursor_target(s))
  return f and f.path
end
local function cursor_text(s)
  return api.nvim_buf_get_lines(s.buf, s:cursor_row(), s:cursor_row() + 1, false)[1]
end
local function ident_of(s, target)
  local id = target and s:safe_row_identity(target)
  if not id then return nil end
  return ("%s:%s:%s:%s"):format(id.kind, tostring(id.sha), id.path, tostring(id.lnum))
end

-- commits -> combined: a line added by the *first* commit and still present at
-- the tip lands on its exact combined counterpart, which blame attributes back
-- to that same commit.
do
  local s = open("commits")
  local row = row_with_text(s, "ALPHA")
  h.assert_true("fixture: ALPHA add row in commit scope", row ~= nil)
  put(s, row)
  local before = ident_of(s, cursor_target(s))
  h.assert_eq("commits->combined: anchored on c1", before,
    ("add:%s:a.txt:2"):format(repo.shas[2]))
  s:set_scope("combined")
  h.assert_eq("commits->combined: exact identity preserved", ident_of(s, cursor_target(s)), before)
  h.assert_eq("commits->combined: cursor on the same text", cursor_text(s), "ALPHA")
end

-- combined -> commits: the combined row's owner sha is the commit to jump into.
do
  local s = open("combined")
  local row = row_with_text(s, "ALPHA")
  put(s, row)
  local before = ident_of(s, cursor_target(s))
  s:set_scope("commits")
  local t = cursor_target(s)
  h.assert_eq("combined->commits: exact identity preserved", ident_of(s, t), before)
  h.assert_eq("combined->commits: landed in the owning commit",
    t and s.commits[t.commit] and s.commits[t.commit].sha, repo.shas[2])
end

-- A del line is owned by the commit that removed it, in both scopes.
do
  local s = open("combined")
  local row = row_with_text(s, "l1")
  h.assert_true("fixture: l1 del row in combined", row ~= nil)
  put(s, row)
  local before = ident_of(s, cursor_target(s))
  h.assert_eq("del: combined attributes the removal to c2", before,
    ("del:%s:a.txt:1"):format(repo.shas[3]))
  s:set_scope("commits")
  h.assert_eq("del: identity preserved into commit scope",
    ident_of(s, cursor_target(s)), before)
end

-- A line introduced and later deleted has no combined counterpart: degrade to
-- the nearest row in the same file rather than losing the file entirely.
do
  local s = open("commits")
  local row = row_with_text(s, "TEMP")
  h.assert_true("fixture: TEMP add row exists in c1", row ~= nil)
  put(s, row)
  s:set_scope("combined")
  h.assert_true("deleted line: TEMP absent from combined", row_with_text(s, "TEMP") == nil)
  h.assert_eq("deleted line: cursor stays in the file", cursor_path(s), "a.txt")
  h.assert_true("deleted line: cursor is on a diff line", cursor_target(s).li ~= nil)
end

-- Round trip returns to the row we started on.
do
  local s = open("combined")
  local row = row_with_text(s, "BETA")
  put(s, row)
  s:set_scope("commits")
  s:set_scope("combined")
  h.assert_eq("round trip: back on the original row", s:cursor_row(), row)
end

-- The destination scope may render the file collapsed; navigation expands it
-- without touching the undo stack.
do
  local s = open("combined")
  local header = find_row(s, function(_, line, t)
    return t and t.cfile and not t.hunk and not t.li and line:find("a.txt", 1, true)
  end)
  h.assert_true("collapsed: found combined a.txt header", header ~= nil)
  put(s, header)
  s:toggle_collapse(header)
  h.assert_true("collapsed: a.txt body hidden", row_with_text(s, "ALPHA") == nil)
  s:set_scope("commits")
  local row = row_with_text(s, "ALPHA")
  put(s, row)
  local depth = #s.undo_stack
  s:set_scope("combined")
  h.assert_eq("collapsed: destination expanded to reach the line", cursor_text(s), "ALPHA")
  h.assert_eq("collapsed: navigation is not undoable", #s.undo_stack, depth)
end

-- A header row has no line identity: restore to the same file's header.
do
  local s = open("combined")
  local header = find_row(s, function(_, line, t)
    return t and t.cfile and not t.hunk and not t.li and line:find("b.txt", 1, true)
  end)
  h.assert_true("header: found combined b.txt header", header ~= nil)
  put(s, header)
  s:set_scope("commits")
  local t = cursor_target(s)
  h.assert_eq("header: landed on a b.txt header", cursor_path(s), "b.txt")
  h.assert_true("header: landed on a header row", t.li == nil)
end

h.finish()
