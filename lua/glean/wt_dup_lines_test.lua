-- Regression: uncommitted deletions whose text repeats nearby must be markable
-- and must stay marked. Seen-ness of a deleted line used to be *derived* by
-- re-diffing the tip commit against the reviewed baseline; with duplicate lines
-- (`--` separators, blanks, `}`) that diff is free to attribute the deletion to
-- a different copy than the one the reviewer marked, which both swallowed the
-- mark and misreported the result. Run with:
--   nvim -l lua/glean/wt_dup_lines_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local glean = require("glean.init")
local testutil = require("glean.testutil")
local h = testutil.new()

-- Two comment-delimited blocks sharing their `--` separator text, of the shape
-- a Postgres schema dump has. The work tree deletes the first block.
local HEAD_TEXT = table.concat({
  "$$;",
  "",
  "--",
  "-- Name: A",
  "--",
  "",
  "BODY A",
  "",
  "--",
  "-- Name: B",
  "--",
  "",
  "BODY B",
}, "\n") .. "\n"

local WT_TEXT = table.concat({
  "$$;",
  "",
  "--",
  "-- Name: B",
  "--",
  "",
  "BODY B",
}, "\n") .. "\n"

local repo = testutil.make_repo({
  { msg = "base", files = { ["schema.sql"] = HEAD_TEXT } },
})

do
  local f = assert(io.open(repo.root .. "/schema.sql", "w"))
  f:write(WT_TEXT)
  f:close()
end

local function inject_run(args)
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

local function open()
  return glean.open({
    base = "HEAD",
    target = glean.WORKTREE,
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = vim.fn.tempname(),
    scope = "combined",
  })
end

-- The single combined-scope file, its hunk, and the owner closure.
local function subject(s)
  s:start_owner_loader()
  local cf = assert(s.combined_files[1], "no combined file")
  return cf, assert(cf.hunks[1], "no hunk"), s:combined_owner(cf.path)
end

-- The head line numbers of the hunk's displayed deletions, in order.
local function del_lnums(hunk)
  local out = {}
  for _, dl in ipairs(hunk.lines) do
    if dl.kind == "del" then out[#out + 1] = dl.old_lnum end
  end
  return out
end

-- Marking the whole hunk closes it.
do
  local s = open()
  local cf, hunk, owner = subject(s)
  local ids = s:changed_lines(hunk, cf.path, owner)
  h.assert_eq("all six deletions are displayed and owned", #ids, 6)
  s:perform({ kind = "seen", ids = ids, op = "mark" })
  h.assert_eq("hunk closes after marking every line", s:hunk_seen(hunk, cf.path, owner), true)
end

-- Marking every deletion but one: each marked line reads seen, the held-out one
-- does not. The held-out line stands in for a deletion whose removal is owned by
-- a commit rather than the work tree, which is how the reported review ended up
-- with a hunk that was 27/28 marked and could not be closed.
for hold = 1, 6 do
  local s = open()
  local cf, hunk, owner = subject(s)
  local lnums = del_lnums(hunk)
  local held = lnums[hold]
  local sel, sel_lnums = {}, {}
  for i, dl in ipairs(hunk.lines) do
    if dl.kind == "del" and dl.old_lnum ~= held then
      sel[#sel + 1] = assert(s:line_identity(dl, cf.path, owner),
        ("del at head line %s is unowned"):format(tostring(dl.old_lnum)))
      sel_lnums[#sel_lnums + 1] = dl.old_lnum
      local _ = i
    end
  end
  s:perform({ kind = "seen", ids = sel, op = "mark" })
  local stuck = {}
  for i, id in ipairs(sel) do
    if not s:id_seen(id) then stuck[#stuck + 1] = sel_lnums[i] end
  end
  h.assert_eq(("hold head line %d: no marked deletion left unseen"):format(held),
    table.concat(stuck, ","), "")
  local held_id
  for _, dl in ipairs(hunk.lines) do
    if dl.kind == "del" and dl.old_lnum == held then
      held_id = s:line_identity(dl, cf.path, owner)
    end
  end
  h.assert_eq(("hold head line %d: the held-out deletion stays unseen"):format(held),
    s:id_seen(assert(held_id)), false)
end

-- Unmarking returns the hunk to unseen, and re-marking closes it again: the
-- explicit head-line set must round-trip, not decay.
do
  local s = open()
  local cf, hunk, owner = subject(s)
  local ids = s:changed_lines(hunk, cf.path, owner)
  s:perform({ kind = "seen", ids = ids, op = "mark" })
  s:perform({ kind = "seen", ids = ids, op = "unmark" })
  h.assert_eq("unmark reopens the hunk", s:hunk_seen(hunk, cf.path, owner), false)
  s:perform({ kind = "seen", ids = ids, op = "mark" })
  h.assert_eq("re-mark closes it again", s:hunk_seen(hunk, cf.path, owner), true)
end

h.finish()
