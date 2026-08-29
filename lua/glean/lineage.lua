-- glean.lineage: compose an ordered sequence of commit patches into per-line
-- ownership for the combined (base..target) view.
--
-- Pure: no git, no nvim API. The input is the ordered list of patches produced
-- by a first-parent `git log -p -U0 -M` walk (parsed by glean.diff); the output
-- is, per path, the two maps the review model addresses lines by:
--   prov[new_lnum]     = { sha, lnum }  -- who wrote this surviving line, and
--                                          its number in that commit's blob
--   del_attr[old_lnum] = { sha, lnum }  -- who removed this base line, and its
--                                          number in that commit's pre-image
--
-- The walk models each path as an ordered list of *segments*, each covering a
-- run of consecutive lines of the file as it stands after the patches applied
-- so far:
--   { base = B, n = k }            k lines inherited from the base image at B
--   { sha = C, lnum = L, n = k }   k lines added by C at L in C's post-image
-- The list ends with an open-ended base segment (n = nil, "and the rest of the
-- file") so the file's length is never needed. One hunk is one splice, so the
-- structure is O(hunks) rather than O(file size).
local M = {}

local INF = math.huge

local function origin_at(s, off)
  if s.base then return { base = s.base + off } end
  return { sha = s.sha, lnum = s.lnum + off }
end

-- A sub-segment of `s` starting `off` lines in, covering `count` lines
-- (count == nil means open-ended).
local function slice(s, off, count)
  local out = origin_at(s, off)
  out.n = count
  return out
end

-- The initial state of a path that exists in the base image: every line is a
-- base line, at the same number.
function M.base_state()
  return { { base = 1 } }
end

-- Cut `remove_n` lines starting at position `at` out of `segments` and
-- substitute `seg` (which may be nil or zero-width for a pure deletion).
-- Returns the new segment list and the ordered list of displaced origins.
function M.splice(segments, at, remove_n, seg)
  local res, displaced = {}, {}
  local cut_end = at + remove_n
  local inserted = false

  local function push(s)
    if s and (s.n == nil or s.n > 0) then res[#res + 1] = s end
  end
  local function insert_seg()
    if inserted then return end
    inserted = true
    if seg and (seg.n or 0) > 0 then res[#res + 1] = seg end
  end

  local pos = 1
  for _, s in ipairs(segments) do
    local inf = s.n == nil
    local n = inf and INF or s.n
    local s_end = pos + n

    local head_n = math.min(n, math.max(0, at - pos))
    if head_n > 0 then push(slice(s, 0, head_n)) end

    if at <= s_end then insert_seg() end

    local mid_start = math.max(pos, at)
    local mid_end = math.min(s_end, cut_end)
    for k = mid_start, mid_end - 1 do
      displaced[#displaced + 1] = origin_at(s, k - pos)
    end

    local tail_start = math.max(pos, cut_end)
    if tail_start < s_end then
      -- `inf and nil or x` would always take the `or` branch (nil is falsy),
      -- turning the open-ended tail into a segment of length inf.
      local tail_n = nil
      if not inf then tail_n = s_end - tail_start end
      push(slice(s, tail_start - pos, tail_n))
    end

    if inf then break end
    pos = s_end
  end
  insert_seg()

  return res, displaced
end

-- Debug/testing helper: the origins of lines 1..n as a plain array.
function M.expand(segments, n)
  local out = {}
  local pos = 1
  for _, s in ipairs(segments) do
    local count = s.n or (n - pos + 1)
    for i = 1, count do
      if pos > n then return out end
      out[pos] = origin_at(s, i - 1)
      pos = pos + 1
    end
  end
  return out
end

-- Split a hunk's lines into contiguous change blocks (with -U0 there is exactly
-- one, but context lines are tolerated). Each block is
--   { at = <pre-image position>, dels = k, lnum = <new_lnum of first add>, adds = m }
local function blocks_of(hunk)
  local out = {}
  -- For a pure insertion git reports old_start as the line the text goes
  -- *after*, so the zero-width insert lands at old_start + 1.
  local next_old = hunk.old_count == 0 and hunk.old_start + 1 or hunk.old_start
  local cur = nil
  local function flush()
    if cur then out[#out + 1] = cur end
    cur = nil
  end
  for _, dl in ipairs(hunk.lines) do
    if dl.kind == "context" then
      flush()
      next_old = dl.old_lnum + 1
    elseif dl.kind == "del" then
      if cur and cur.adds > 0 then flush() end
      cur = cur or { at = dl.old_lnum, dels = 0, adds = 0 }
      cur.dels = cur.dels + 1
      next_old = dl.old_lnum + 1
    elseif dl.kind == "add" then
      cur = cur or { at = next_old, dels = 0, adds = 0 }
      cur.lnum = cur.lnum or dl.new_lnum
      cur.adds = cur.adds + 1
    end
  end
  flush()
  return out
end

-- Apply one commit's FileEntry to one path's state.
--   state = { segs = <segment list>, del_attr = <map> }
-- Hunk positions are expressed against the commit's *pre-image*, so a running
-- offset translates them into the (already partially spliced) running image.
function M.apply(state, sha, file)
  local offset = 0
  for _, hunk in ipairs(file.hunks or {}) do
    for _, b in ipairs(blocks_of(hunk)) do
      local seg = b.adds > 0 and { sha = sha, lnum = b.lnum, n = b.adds } or nil
      local segs, displaced = M.splice(state.segs, b.at + offset, b.dels, seg)
      state.segs = segs
      for i, origin in ipairs(displaced) do
        if origin.base then
          state.del_attr[origin.base] = { sha = sha, lnum = b.at + i - 1 }
        end
      end
      offset = offset + b.adds - b.dels
    end
  end
  return state
end

-- Apply an ordered (oldest-first) list of patches `{ sha, files }` on top of
-- `states` (the per-path segment/attribution state produced by earlier
-- patches), mutating and returning it. Splitting this out of `compose` lets a
-- refresh keep the committed layers' state and re-apply only the work-tree
-- layer over a clone of it.
function M.extend(states, patches)
  local function state_for(path, kind)
    local st = states[path]
    if not st then
      st = { segs = kind == "add" and {} or M.base_state(), del_attr = {} }
      states[path] = st
    end
    return st
  end

  for _, patch in ipairs(patches) do
    for _, file in ipairs(patch.files or {}) do
      if file.old_path and file.old_path ~= file.path and file.old_path ~= "/dev/null" then
        local prev = states[file.old_path]
        if prev then
          states[file.path] = prev
          states[file.old_path] = nil
        end
      end
      local st = state_for(file.path, file.kind)
      M.apply(st, patch.sha, file)
      if file.kind == "delete" then
        -- A re-add must start from nothing: no origin survives the delete, and
        -- the base lines have just been attributed to the deleter.
        states[file.path] = { segs = {}, del_attr = st.del_attr }
      end
    end
  end

  return states
end

-- Deep-copy a states table, so a layer can be applied on top without
-- destroying the state the copy was taken from.
function M.clone(states)
  local out = {}
  for path, st in pairs(states) do
    local segs, del_attr = {}, {}
    for i, s in ipairs(st.segs) do segs[i] = { base = s.base, sha = s.sha, lnum = s.lnum, n = s.n } end
    for k, v in pairs(st.del_attr) do del_attr[k] = v end
    out[path] = { segs = segs, del_attr = del_attr }
  end
  return out
end

-- Project composed states into the two maps the review model addresses lines
-- by: { [path] = { prov = {...}, del_attr = {...} } }.
function M.finish(states)
  local out = {}
  for path, st in pairs(states) do
    local prov = {}
    local pos = 1
    for _, s in ipairs(st.segs) do
      if s.n == nil then break end
      if not s.base then
        for i = 1, s.n do prov[pos + i - 1] = { sha = s.sha, lnum = s.lnum + i - 1 } end
      end
      pos = pos + s.n
    end
    out[path] = { prov = prov, del_attr = st.del_attr }
  end
  return out
end

-- Compose an ordered (oldest-first) list of patches into the per-path maps.
function M.compose(patches)
  return M.finish(M.extend({}, patches))
end

return M
