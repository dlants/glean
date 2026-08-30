-- glean.baseline: the pure algebra of the *reviewed baseline* R for a single
-- uncommitted file. See plans/2026-08-28-reviewed-baseline.md.
--
-- Three versions are in play, each a plain list of lines:
--   head     (H) the file at the review's tip commit — immutable,
--   reviewed (R) the content the reviewer has signed off on,
--   worktree (W) the file as it is right now.
--
-- The displayed diff is D = diff(H, W). This module decides only its *added*
-- lines: an add at work-tree line N is seen iff it is not an add of
-- diff(R, W), an exact line-number comparison in the version those two diffs
-- share. Nothing is ever located by text search. Deleted lines are not decided
-- here at all -- H is immutable while a baseline record lives, so approved
-- deletions are stored explicitly as H line numbers by the session (see
-- plans/2026-08-29-explicit-del-seen.md). R therefore only ever grows toward
-- W, and diff(H, R) is add-only.
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

--- Seen-ness of the *added* lines of the displayed diff D = diff(head,
--- worktree), keyed by work-tree line number: an add at N is seen iff it is
--- not an add of diff(reviewed, worktree). Deleted lines are not decided here
--- -- they are stored explicitly as head line numbers by the caller.
--- @return table<integer, boolean>
function M.seen_adds(reviewed, worktree)
  local add = {}
  for n = 1, #worktree do
    add[n] = true
  end
  for _, op in ipairs(M.align(reviewed, worktree)) do
    if op.kind == "add" then add[op.b_lnum] = false end
  end
  return add
end

--- R' after marking work-tree lines `sel_add` seen: grow R toward W over
--- exactly those lines. R is never shortened, so diff(head, R) stays add-only.
--- @param sel_add integer[] work-tree line numbers
--- @return string[]
function M.mark_adds(reviewed, worktree, sel_add)
  local sel = {}
  for _, n in ipairs(sel_add or {}) do
    sel[n] = true
  end
  local out = {}
  for _, op in ipairs(M.align(reviewed, worktree)) do
    if op.kind == "add" then
      if sel[op.b_lnum] then out[#out + 1] = op.text end
    else -- context, or a line of R absent from W: R keeps it either way
      out[#out + 1] = op.text
    end
  end
  return out
end

--- R' after unmarking work-tree lines `sel_add`: drop them from R unless they
--- are head lines (R is never shrunk below H).
--- @param sel_add integer[] work-tree line numbers
--- @return string[]
function M.unmark_adds(head, reviewed, worktree, sel_add)
  local u = M.align(reviewed, worktree)
  local drop_r = {}
  for _, n in ipairs(sel_add or {}) do
    local r = M.map_back(u, n)
    if r then drop_r[r] = true end
  end
  local out = {}
  for _, op in ipairs(M.align(head, reviewed)) do
    if op.kind == "add" then
      if not drop_r[op.b_lnum] then out[#out + 1] = op.text end
    else -- context, or a head line missing from R: keep the head line
      out[#out + 1] = op.text
    end
  end
  return out
end

return M
