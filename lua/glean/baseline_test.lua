-- Tier 1 tests for glean.baseline (pure reviewed-baseline algebra).
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

-- Render seen-ness of the displayed diff D = diff(base, worktree) as a compact
-- string: one entry per displayed add/del line, e.g. "+3:seen -2:unseen".
local function render(base, reviewed, worktree)
  local sets = baseline.seen_sets(base, reviewed, worktree)
  local parts = {}
  for _, op in ipairs(baseline.align(base, worktree)) do
    if op.kind == "add" then
      parts[#parts + 1] = ("+%d:%s"):format(op.b_lnum, sets.add[op.b_lnum] and "seen" or "unseen")
    elseif op.kind == "del" then
      parts[#parts + 1] = ("-%d:%s"):format(op.a_lnum, sets.del[op.a_lnum] and "seen" or "unseen")
    end
  end
  return table.concat(parts, " ")
end

-- All displayed adds/dels of diff(base, worktree), i.e. "mark everything".
local function all_sel(base, worktree)
  local sel = { add = {}, del = {} }
  for _, op in ipairs(baseline.align(base, worktree)) do
    if op.kind == "add" then
      sel.add[#sel.add + 1] = op.b_lnum
    elseif op.kind == "del" then
      sel.del[#sel.del + 1] = op.a_lnum
    end
  end
  return sel
end

local function eq_lines(name, actual, expected)
  h.assert_eq(name, table.concat(actual, "|"), table.concat(expected, "|"))
end

-- Baseline scenario: a three-line insertion into a five-line file, marked seen,
-- then one of the three edited. Only the edited line comes back unseen.
local base = lines("a\nb\nc\nd\ne")
local function edited_case(name, edit_idx, new_text)
  local wt = lines("a\nb\nx\ny\nz\nc\nd\ne")
  local reviewed = baseline.mark(base, base, wt, all_sel(base, wt))
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
  local reviewed = baseline.mark(base, base, wt, all_sel(base, wt))
  local wt2 = lines("a\nb\nx\nNEW\ny\nz\nc\nd\ne")
  h.assert_eq("insert into marked run", render(base, reviewed, wt2), "+3:seen +4:unseen +5:seen +6:seen")
end

-- Shifting a marked region (text inserted above it): it stays seen, because
-- the diff follows it rather than matching it by position. A wholesale *move*
-- across the file is not covered: vim.diff is not move-aware, so the region
-- reads as a fresh insertion elsewhere and is unseen.
do
  local wt = lines("a\nb\nx\ny\nc\nd\ne")
  local reviewed = baseline.mark(base, base, wt, all_sel(base, wt))
  local wt2 = lines("a\nNEW\nb\nx\ny\nc\nd\ne")
  h.assert_eq("shifted marked region", render(base, reviewed, wt2), "+2:unseen +4:seen +5:seen")
end

-- Two identical new lines far apart: marking one leaves the other unseen.
do
  local wt = lines("a\ndup\nb\nc\nd\ndup\ne")
  local reviewed = baseline.mark(base, base, wt, { add = { 2 } })
  h.assert_eq("duplicate lines", render(base, reviewed, wt), "+2:seen +6:unseen")
end

-- Deletions: marking a del removes the line from R and it reads seen.
do
  local wt = lines("a\nb\nd\ne")
  h.assert_eq("unmarked del", render(base, base, wt), "-3:unseen")
  local reviewed = baseline.mark(base, base, wt, { del = { 3 } })
  eq_lines("mark del: R == W", reviewed, wt)
  h.assert_eq("marked del", render(base, reviewed, wt), "-3:seen")
  -- Restoring the deleted line in the work tree: D is empty, and R (which
  -- lacks the line) is simply not consulted about it.
  h.assert_eq("del restored in W", render(base, reviewed, base), "")
end

-- A del and an add in one selection, marked together.
do
  local wt = lines("a\nb\nC\nd\ne")
  local reviewed = baseline.mark(base, base, wt, all_sel(base, wt))
  h.assert_eq("changed line", render(base, reviewed, wt), "-3:seen +3:seen")
  eq_lines("changed line: R == W", reviewed, wt)
end

-- Partial selection: mark only one of two independent changes.
do
  local wt = lines("a\nP\nb\nc\nd\ne\nQ")
  local reviewed = baseline.mark(base, base, wt, { add = { 7 } })
  h.assert_eq("partial mark", render(base, reviewed, wt), "+2:unseen +7:seen")
end

-- mark is idempotent; unmark inverts mark exactly.
do
  local wt = lines("a\nP\nc\nd\ne\nQ") -- adds P, drops b, appends Q
  local sel = all_sel(base, wt)
  local r1 = baseline.mark(base, base, wt, sel)
  local r2 = baseline.mark(base, r1, wt, sel)
  eq_lines("mark idempotent", r2, r1)
  eq_lines("unmark inverts mark", baseline.unmark(base, r1, wt, sel), base)
  h.assert_eq("unmarked: all unseen", render(base, baseline.unmark(base, r1, wt, sel), wt), render(base, base, wt))

  -- Same for a partial selection.
  local partial = { add = { 2 }, del = { 2 } }
  local p1 = baseline.mark(base, base, wt, partial)
  local p2 = baseline.mark(base, p1, wt, partial)
  eq_lines("partial mark idempotent", p2, p1)
  eq_lines("partial unmark inverts", baseline.unmark(base, p1, wt, partial), base)
end

-- Empty files at either endpoint.
do
  local wt = lines("a\nb")
  local reviewed = baseline.mark({}, {}, wt, all_sel({}, wt))
  eq_lines("mark from empty base", reviewed, wt)
  h.assert_eq("new file all seen", render({}, reviewed, wt), "+1:seen +2:seen")
  local gone = baseline.mark(base, base, {}, all_sel(base, {}))
  eq_lines("mark whole-file deletion", gone, {})
end

h.finish()
