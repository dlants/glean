-- glean.api: the flat, row-free programmatic surface over a live review.
--
-- External callers (magenta driving `nvim_exec_lua`) reach glean only through
-- this module. Every argument and every returned field is a string or a number,
-- so each call round-trips through JSON and is self-contained: a review is
-- addressed by its process-local session id (`g1`, rendered in the buffer
-- name), a comment by its stored id (rendered as `[7]` in the buffer body).
--
-- The api never re-implements anchoring, rendering or persistence; it adapts
-- what `Session` already does.
local glean = require("glean.init")
local state = require("glean.state")
local M = {}
-- The open reviews, in id order. Purely descriptive: no lua objects cross the
-- boundary, only the fields needed to pick one.
function M.sessions()
  local out = {}
  for _, s in ipairs(glean.live_sessions()) do
    out[#out + 1] = {
      id = s.id,
      repo = s.git.repo_root,
      base = s.base,
      target = s.target,
      scope = s.scope,
      title = vim.api.nvim_buf_get_name(s.buf),
    }
  end
  return out
end
local function describe(entry)
  return ("%s (%s %s..%s)"):format(entry.id, entry.repo, entry.base, entry.target)
end
-- Resolve a session id (or buffer number) to the live Session. Internal: the
-- only entry point that returns a lua object. Errors — never a silent nil — name
-- the fix, listing the candidates when the choice is ambiguous.
function M.session(id)
  local live = glean.live_sessions()
  if #live == 0 then
    error("glean: no review is open; open one with :Glean before using glean.api", 0)
  end
  if id == nil then
    if #live == 1 then return live[1] end
    local names = {}
    for i, entry in ipairs(M.sessions()) do names[i] = describe(entry) end
    error("glean: " .. #live .. " reviews are open; pass a session id — "
      .. table.concat(names, ", "), 0)
  end
  for _, s in ipairs(live) do
    if s.id == id or s.buf == id then return s end
  end
  local names = {}
  for i, entry in ipairs(M.sessions()) do names[i] = describe(entry) end
  error(("glean: no review with session id %q; open reviews: %s")
    :format(tostring(id), table.concat(names, ", ")), 0)
end
-- The display line number and side of a resolved diff line: post-image for adds
-- and context, pre-image for deletions.
local function line_position(dl)
  if not dl then return nil, nil end
  if dl.kind == "del" then return dl.old_lnum, "old" end
  return dl.new_lnum, "new"
end
-- Every comment in the review, flattened and read-only. Walks the exact
-- canonical files (so comments in whitespace-hidden files stay visible) and
-- re-anchors each record against the current diff. Order is deterministic:
-- file order, then anchored position, then authoring order.
function M.comments(session, opts)
  opts = opts or {}
  local s = M.session(session)
  local out = {}
  for _, pair in ipairs(s:comment_file_pairs()) do
    local path = pair.exact.path
    if not opts.path or opts.path == path then
      local flat = glean.flatten_diff_lines(pair.exact)
      local texts = {}
      for i, dl in ipairs(flat) do texts[i] = dl.text end
      local rows = {}
      for order, rec in ipairs(s.store:comments_for(path)) do
        local start = state.resolve(rec.content, rec.anchor, texts)
        local dl = flat[start or rec.anchor]
        local lnum, side = line_position(dl)
        rows[#rows + 1] = {
          order = order,
          position = start or rec.anchor or 0,
          entry = {
            id = rec.id,
            path = path,
            lnum = lnum,
            side = side,
            text = rec.text,
            reply = rec.reply,
            content = rec.content,
            code = table.concat(rec.content, "\n"),
            outdated = start == nil,
          },
        }
      end
      table.sort(rows, function(a, b)
        if a.position ~= b.position then return a.position < b.position end
        return a.order < b.order
      end)
      for _, row in ipairs(rows) do
        if not (opts.unanswered and row.entry.reply ~= nil) then
          out[#out + 1] = row.entry
        end
      end
    end
  end
  return out
end
return M
