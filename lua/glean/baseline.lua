-- glean.baseline: the pure algebra of the *reviewed baseline* R for a single
-- uncommitted file. See plans/2026-08-28-reviewed-baseline.md.
--
-- Three versions are in play, each a plain list of lines:
--   base     (H) the file at the review's tip commit — immutable,
--   reviewed (R) the content the reviewer has signed off on,
--   worktree (W) the file as it is right now.
--
-- The displayed diff is D = diff(H, W). Seen-ness is decided by exact line
-- numbers in the version each pair of diffs shares: an added line of D (a W
-- line) against diff(R, W), a deleted line of D (an H line) against
-- diff(H, R). Nothing is ever located by text search.
--
-- No git, no store, no nvim API beyond `vim.diff`, so this is headless-testable
-- like glean.diff and glean.intraline.
local M = {}

--- One aligned line of a diff between two in-memory texts.
--- @class glean.baseline.Op
--- @field kind "context"|"add"|"del"
--- @field text string
--- @field a_lnum integer|nil 1-based line in the pre-image (nil for "add")
--- @field b_lnum integer|nil 1-based line in the post-image (nil for "del")

local function join(lines)
  if #lines == 0 then return "" end
  return table.concat(lines, "\n") .. "\n"
end

--- Align two line lists into a full-file op list (every line of both sides
--- appears exactly once, in order).
--- @param a string[]
--- @param b string[]
--- @return glean.baseline.Op[]
function M.align(a, b)
  local hunks = vim.diff(join(a), join(b), { result_type = "indices" })
  local ops = {}
  local ai, bi = 1, 1
  local function context_to(a_stop)
    while ai < a_stop do
      ops[#ops + 1] = { kind = "context", text = a[ai], a_lnum = ai, b_lnum = bi }
      ai, bi = ai + 1, bi + 1
    end
  end
  for _, h in ipairs(hunks or {}) do
    local sa, ca, _, cb = h[1], h[2], h[3], h[4]
    -- vim.diff reports a zero-count side as "after this line", so the hunk
    -- actually starts one line later on that side.
    context_to(ca == 0 and sa + 1 or sa)
    for _ = 1, ca do
      ops[#ops + 1] = { kind = "del", text = a[ai], a_lnum = ai }
      ai = ai + 1
    end
    for _ = 1, cb do
      ops[#ops + 1] = { kind = "add", text = b[bi], b_lnum = bi }
      bi = bi + 1
    end
  end
  context_to(#a + 1)
  return ops
end

--- Map a pre-image line forward through an alignment. nil when the line did
--- not survive (it was deleted or replaced).
--- @param ops glean.baseline.Op[]
--- @return integer|nil
function M.map_forward(ops, a_lnum)
  for _, op in ipairs(ops) do
    if op.a_lnum == a_lnum then return op.b_lnum end
  end
  return nil
end

--- Map a post-image line back through an alignment. nil when the line is not
--- present in the pre-image (it was added).
--- @param ops glean.baseline.Op[]
--- @return integer|nil
function M.map_back(ops, b_lnum)
  for _, op in ipairs(ops) do
    if op.b_lnum == b_lnum then return op.a_lnum end
  end
  return nil
end

--- Seen-ness for one file, as dense predicates over line numbers of the
--- displayed diff D = diff(base, worktree):
---   `add[N]` for a displayed add at worktree line N,
---   `del[P]` for a displayed del at base line P.
--- Lines that are not part of D are still keyed (they read as seen); callers
--- only ever ask about lines D actually displays.
--- @return { add: table<integer, boolean>, del: table<integer, boolean> }
function M.seen_sets(base, reviewed, worktree)
  local u = M.align(reviewed, worktree)
  local a = M.align(base, reviewed)
  local add, del = {}, {}
  for n = 1, #worktree do
    add[n] = true
  end
  for _, op in ipairs(u) do
    -- Present in W but not in R: the reviewer has not approved this text.
    if op.kind == "add" then add[op.b_lnum] = false end
  end
  for p = 1, #base do
    del[p] = false
  end
  for _, op in ipairs(a) do
    -- Absent from R as well as from W: the removal is approved.
    if op.kind == "del" then del[op.a_lnum] = true end
  end
  return { add = add, del = del }
end

--- Normalize a selection of displayed lines into lookup sets.
local function sel_sets(sel)
  local add, del = {}, {}
  for _, n in ipairs((sel or {}).add or {}) do
    add[n] = true
  end
  for _, p in ipairs((sel or {}).del or {}) do
    del[p] = true
  end
  return add, del
end

--- R' after marking `sel` seen: advance R toward W over the selected lines.
--- `sel` is `{ add = { <worktree lnum>, ... }, del = { <base lnum>, ... } }`.
--- @return string[]
function M.mark(base, reviewed, worktree, sel)
  local sel_add, sel_del = sel_sets(sel)
  local a = M.align(base, reviewed)
  -- A selected displayed del still lives in R (it is unseen), at the line the
  -- base line maps forward to through diff(base, reviewed).
  local drop_r = {}
  for p in pairs(sel_del) do
    local r = M.map_forward(a, p)
    if r then drop_r[r] = true end
  end
  local out = {}
  for _, op in ipairs(M.align(reviewed, worktree)) do
    if op.kind == "context" then
      out[#out + 1] = op.text
    elseif op.kind == "add" then
      if sel_add[op.b_lnum] then out[#out + 1] = op.text end
    else -- del: a line of R absent from W; keep it unless its removal is marked
      if not drop_r[op.a_lnum] then out[#out + 1] = op.text end
    end
  end
  return out
end

--- R' after unmarking `sel`: retreat R toward base over the selected lines.
--- @return string[]
function M.unmark(base, reviewed, worktree, sel)
  local sel_add, sel_del = sel_sets(sel)
  local u = M.align(reviewed, worktree)
  -- A selected displayed add is already in R (it is seen), at the line the
  -- worktree line maps back to through diff(reviewed, worktree).
  local drop_r = {}
  for n in pairs(sel_add) do
    local r = M.map_back(u, n)
    if r then drop_r[r] = true end
  end
  local out = {}
  for _, op in ipairs(M.align(base, reviewed)) do
    if op.kind == "context" then
      out[#out + 1] = op.text
    elseif op.kind == "add" then
      if not drop_r[op.b_lnum] then out[#out + 1] = op.text end
    else -- del: approved removal of a base line; restore it when unmarked
      if sel_del[op.a_lnum] then out[#out + 1] = op.text end
    end
  end
  return out
end

return M
