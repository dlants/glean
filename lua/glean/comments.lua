-- Comment records: a selection of lines, annotated per entry, resolvable
-- against either a diff (all entries) or a plain file (non-deleted entries).
-- Pure: no nvim API, no IO.
local state = require("glean.state")

local M = {}

-- Every entry's text, in order — the sequence a diff view searches.
function M.diff_projection(record)
  local out = {}
  for _, e in ipairs(record.content or {}) do out[#out + 1] = e.text end
  return out
end

-- The post-image lines of the selection — the sequence a file view searches.
function M.file_projection(record)
  local out = {}
  for _, e in ipairs(record.content or {}) do
    if e.kind ~= "del" then out[#out + 1] = e.text end
  end
  return out
end

-- Resolve `record` against `lines` (a sequence of line texts). `lnum_of(i)`
-- maps an index in `lines` to a post-image line number (identity for a file
-- buffer). `projection` is "diff" (default) or "file".
-- Returns { index, lnum, outdated }: `index` is the match start in `lines` (nil
-- when outdated) and `lnum` the resolved line, or the fallback slot — the index
-- whose lnum is nearest the record's `lnum` — when nothing matches.
function M.locate(record, lines, lnum_of, projection)
  lnum_of = lnum_of or function(i) return i end
  local needles = projection == "file" and M.file_projection(record)
    or M.diff_projection(record)
  local anchor = record.lnum
  if #needles > 0 then
    local start = state.resolve(needles, lines, lnum_of, anchor)
    if start then
      return { index = start, lnum = lnum_of(start), outdated = false }
    end
  end
  local best, best_lnum, best_dist
  for i = 1, #lines do
    local l = lnum_of(i)
    if l then
      local dist = math.abs(l - (anchor or 0))
      if not best_dist or dist < best_dist then best, best_lnum, best_dist = i, l, dist end
    end
  end
  return { index = nil, lnum = best_lnum or anchor, fallback = best, outdated = true }
end

return M
