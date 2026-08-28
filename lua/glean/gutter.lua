-- glean.gutter: the gutter projection of a reviewed file.
--
-- Stage 1 is the pure part only: turning a file's hunks plus a seen predicate
-- into a post-image `lnum -> mark` map. No nvim API here, so it unit-tests
-- headless like glean.diff / glean.intraline.
local intraline = require("glean.intraline")

local M = {}

--- @alias GleanGutterMark { kind: string?, del_below: boolean?, del_above: boolean?, seen: boolean }

-- Fold one more identity's seen-ness into a row's mark: a row that stands for
-- several diff lines (a change row, a row carrying deletions) reads as seen only
-- when every one of them is.
local function fold(marks, lnum, seen, fields)
  local m = marks[lnum]
  if not m then
    m = { seen = true }
    marks[lnum] = m
  end
  m.seen = m.seen and seen
  for k, v in pairs(fields) do
    m[k] = v
  end
  return m
end

-- Attach an unpaired deletion to the nearest *post-image* row: the row above the
-- slot it was removed from, or row 1 (as `del_above`) when it was removed from
-- the top of the file.
-- ...within a block that also has added lines the deletion belongs to the edited
-- region, so it ticks the block's last post-image row rather than the context
-- line above the block.
local function mark_deletion(marks, dl, seen)
  local above = (dl.new_lnum or 1) - 1
  if above >= 1 then
    fold(marks, above, seen, { del_below = true })
  else
    fold(marks, 1, seen, { del_above = true })
  end
end

-- Classify one del/add block. Coupling is `intraline.pair_lines`, the same
-- similarity pairing the review buffer uses for intra-line emphasis, so "this
-- looks like an edit" means the same thing in both places.
local function project_block(marks, dels, adds)
  local del_texts, add_texts = {}, {}
  for i, d in ipairs(dels) do
    del_texts[i] = d.dl.text
  end
  for i, a in ipairs(adds) do
    add_texts[i] = a.dl.text
  end
  local paired = intraline.pair_lines(del_texts, add_texts)
  local del_used = {}
  for _, p in ipairs(paired.pairs) do
    local d, a = dels[p[1]], adds[p[2]]
    del_used[p[1]] = true
    fold(marks, a.dl.new_lnum, a.seen and d.seen, { kind = "change" })
  end
  for _, ai in ipairs(paired.add_unpaired) do
    local a = adds[ai]
    fold(marks, a.dl.new_lnum, a.seen, { kind = "add" })
  end
  local anchor = #adds > 0 and adds[#adds].dl.new_lnum or nil
  for di = 1, #dels do
    if not del_used[di] then
      if anchor then
        fold(marks, anchor, dels[di].seen, { del_below = true })
      else
        mark_deletion(marks, dels[di].dl, dels[di].seen)
      end
    end
  end
end

--- Pure. `hunks` is a FileEntry's hunk list; `is_seen(dl, hunk, i)` answers
--- seen-ness for one diff line (`i` is its index within `hunk.lines`).
--- Returns `lnum -> GleanGutterMark` in post-image coordinates.
--- @return table<integer, GleanGutterMark>
function M.project(hunks, is_seen)
  local marks = {}
  for _, hunk in ipairs(hunks or {}) do
    local lines = hunk.lines or {}
    local i = 1
    while i <= #lines do
      local dl = lines[i]
      if dl.kind == "context" then
        i = i + 1
      else
        local dels, adds = {}, {}
        while i <= #lines and lines[i].kind ~= "context" do
          local cur = lines[i]
          local entry = { dl = cur, seen = is_seen(cur, hunk, i) and true or false }
          if cur.kind == "del" then
            dels[#dels + 1] = entry
          else
            adds[#adds + 1] = entry
          end
          i = i + 1
        end
        project_block(marks, dels, adds)
      end
    end
  end
  return marks
end

return M
