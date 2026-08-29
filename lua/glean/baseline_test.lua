-- Tier 1 tests for glean.baseline (pure reviewed-baseline algebra).
-- The baseline covers *additions* only: R is grown toward W and never shrunk
-- below H, so diff(H, R) is add-only. Deletions are stored explicitly by the
-- session as head line numbers and are not decided here.
-- Run with: nvim -l lua/glean/baseline_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local baseline = require("glean.baseline")
local h = require("glean.testutil").new()

local function lines(s)
  local out = {}
  for line in (s .. "\n"):gmatch("([^\n]*)\n") do
    out[#out + 1] = line
  end
  return out
end

-- Render seen-ness of the displayed adds of D = diff(base, worktree) as a
-- compact string, e.g. "+3:seen +4:unseen".
local function render(base, reviewed, worktree)
  local add = baseline.seen_adds(reviewed, worktree)
  local parts = {}
  for _, op in ipairs(baseline.align(base, worktree)) do
    if op.kind == "add" then
      parts[#parts + 1] = ("+%d:%s"):format(op.b_lnum, add[op.b_lnum] and "seen" or "unseen")
    end
  end
  return table.concat(parts, " ")
end

-- All displayed adds of diff(base, worktree), i.e. "mark everything".
local function all_adds(base, worktree)
  local sel = {}
  for _, op in ipairs(baseline.align(base, worktree)) do
    if op.kind == "add" then sel[#sel + 1] = op.b_lnum end
  end
  return sel
end

local function eq_lines(name, actual, expected)
  h.assert_eq(name, table.concat(actual, "|"), table.concat(expected, "|"))
end

-- R must never shrink below H: diff(head, R) carries no del op.
local function assert_add_only(name, head, reviewed)
  local dels = 0
  for _, op in ipairs(baseline.align(head, reviewed)) do
    if op.kind == "del" then dels = dels + 1 end
  end
  h.assert_eq(name .. ": diff(H, R) add-only", dels, 0)
end

-- Baseline scenario: a three-line insertion into a five-line file, marked seen,
-- then one of the three edited. Only the edited line comes back unseen.
local base = lines("a\nb\nc\nd\ne")
local function edited_case(name, edit_idx, new_text)
  local wt = lines("a\nb\nx\ny\nz\nc\nd\ne")
  local reviewed = baseline.mark_adds(base, wt, all_adds(base, wt))
  eq_lines("mark " .. name .. ": R == W", reviewed, wt)
  h.assert_eq("marked " .. name .. ": all seen", render(base, reviewed, wt), "+3:seen +4:seen +5:seen")
  local wt2 = vim.deepcopy(wt)
  wt2[edit_idx] = new_text
  h.assert_eq(
    "edited " .. name,
    render(base, reviewed, wt2),
    ("+3:%s +4:%s +5:%s"):format(
      edit_idx == 3 and "unseen" or "seen",
      edit_idx == 4 and "unseen" or "seen",
      edit_idx == 5 and "unseen" or "seen"
    )
  )
  -- Reverting the edit restores seen-ness: the line matches R again.
  h.assert_eq("reverted " .. name, render(base, reviewed, wt), "+3:seen +4:seen +5:seen")
end
edited_case("first line of run", 3, "X")
edited_case("middle of run", 4, "Y")
edited_case("last line of run", 5, "Z")

-- Inserting a line into the middle of a marked run: only the new line is
-- unseen; both halves stay seen. Block records cannot express this.
do
  local wt = lines("a\nb\nx\ny\nz\nc\nd\ne")
  local reviewed = baseline.mark_adds(base, wt, all_adds(base, wt))
  local wt2 = lines("a\nb\nx\nNEW\ny\nz\nc\nd\ne")
  h.assert_eq("insert into marked run", render(base, reviewed, wt2), "+3:seen +4:unseen +5:seen +6:seen")
end

-- Shifting a marked region (text inserted above it): it stays seen, because
-- the diff follows it rather than matching it by position.
do
  local wt = lines("a\nb\nx\ny\nc\nd\ne")
  local reviewed = baseline.mark_adds(base, wt, all_adds(base, wt))
  local wt2 = lines("a\nNEW\nb\nx\ny\nc\nd\ne")
  h.assert_eq("shifted marked region", render(base, reviewed, wt2), "+2:unseen +4:seen +5:seen")
end

-- Two identical new lines far apart: marking one leaves the other unseen.
do
  local wt = lines("a\ndup\nb\nc\nd\ndup\ne")
  local reviewed = baseline.mark_adds(base, wt, { 2 })
  h.assert_eq("duplicate lines", render(base, reviewed, wt), "+2:seen +6:unseen")
end

-- Deletions do not touch R at all: marking every add of a file whose work tree
-- also drops lines leaves those head lines in R.
do
  local wt = lines("a\nb\nd\ne") -- drops "c"
  local reviewed = baseline.mark_adds(base, wt, all_adds(base, wt))
  eq_lines("deletion left in R", reviewed, base)
  assert_add_only("deletion", base, reviewed)
end

-- Duplicate-heavy fixture from the bug report: a `--`-delimited block deleted
-- wholesale, with the separator repeated inside and after it. R must not
-- shrink, whatever alignment vim.diff picks.
do
  local dup_head = lines("$$;\n\n--\n-- Name: A\n--\n\nBODY A\n\n--\n-- Name: B\n--\n\nBODY B")
  local dup_wt = lines("$$;\n\n--\n-- Name: B\n--\n\nBODY B\nNEW")
  local reviewed = baseline.mark_adds(dup_head, dup_wt, all_adds(dup_head, dup_wt))
  h.assert_eq("dup fixture: R not shortened", #reviewed >= #dup_head, true)
  assert_add_only("dup fixture", dup_head, reviewed)
  h.assert_eq("dup fixture: adds seen", render(dup_head, reviewed, dup_wt), "+8:seen")
end

-- Partial selection: mark only one of two independent additions.
do
  local wt = lines("a\nP\nb\nc\nd\ne\nQ")
  local reviewed = baseline.mark_adds(base, wt, { 7 })
  h.assert_eq("partial mark", render(base, reviewed, wt), "+2:unseen +7:seen")
end

-- mark_adds is idempotent; unmark_adds inverts it exactly.
do
  local wt = lines("a\nP\nc\nd\ne\nQ") -- adds P, drops b, appends Q
  local sel = all_adds(base, wt)
  local r1 = baseline.mark_adds(base, wt, sel)
  local r2 = baseline.mark_adds(r1, wt, sel)
  eq_lines("mark idempotent", r2, r1)
  assert_add_only("mark", base, r1)
  eq_lines("unmark inverts mark", baseline.unmark_adds(base, r1, wt, sel), base)
  h.assert_eq("unmarked: all unseen", render(base, baseline.unmark_adds(base, r1, wt, sel), wt), render(base, base, wt))

  local partial = { 2 }
  local p1 = baseline.mark_adds(base, wt, partial)
  local p2 = baseline.mark_adds(p1, wt, partial)
  eq_lines("partial mark idempotent", p2, p1)
  eq_lines("partial unmark inverts", baseline.unmark_adds(base, p1, wt, partial), base)
end

-- Empty files at either endpoint.
do
  local wt = lines("a\nb")
  local reviewed = baseline.mark_adds({}, wt, all_adds({}, wt))
  eq_lines("mark from empty base", reviewed, wt)
  h.assert_eq("new file all seen", render({}, reviewed, wt), "+1:seen +2:seen")
  local gone = baseline.mark_adds(base, {}, all_adds(base, {}))
  eq_lines("whole-file deletion leaves R at H", gone, base)
end

h.finish()
