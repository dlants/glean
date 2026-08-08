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
-- ---------------------------------------------------------------------------
-- Hunks — the read side of the review body, and marking it seen.
-- ---------------------------------------------------------------------------
-- A file-path glob ("lua/**/*.lua") as a predicate. Compiled once per query.
local function glob_filter(glob)
  if not glob then return function() return true end end
  local pat = vim.glob.to_lpeg(glob)
  return function(path) return vim.lpeg.match(pat, path) ~= nil end
end
-- The display line number and side of a diff line, plus its rendered body.
local function api_line(session, entry, i)
  local dl = entry.hunk.lines[i]
  local id = session:line_identity(dl, entry.path, entry.owner, entry.base + i)
  local lnum, side = line_position(dl)
  return {
    i = i,
    kind = dl.kind,
    lnum = lnum,
    side = side or "new",
    text = dl.text,
    seen = id ~= nil and session:id_seen(id),
  }
end
-- Project one `Session:all_hunks` entry into its flat, JSON-safe form. Seen-ness
-- is `Session:hunk_seen`/`id_seen`, the same predicates the renderer uses, so an
-- api answer and the buffer can't disagree. The display-only short-run demotion
-- (`min_seen_run`) is deliberately not applied: this reports the stored model.
local function api_hunk(session, entry)
  local h = entry.hunk
  local lines, adds, dels, unseen = {}, 0, 0, 0
  for i, dl in ipairs(h.lines) do
    local line = api_line(session, entry, i)
    lines[i] = line
    if dl.kind == "add" then adds = adds + 1 end
    if dl.kind == "del" then dels = dels + 1 end
    if (dl.kind == "add" or dl.kind == "del") and not line.seen then unseen = unseen + 1 end
  end
  return {
    id = entry.id,
    mode = entry.mode,
    sha = entry.sha,
    path = entry.path,
    kind = entry.file.kind,
    header = h.header,
    old_start = h.old_start,
    old_count = h.old_count,
    new_start = h.new_start,
    new_count = h.new_count,
    seen = session:hunk_seen(h, entry.path, entry.owner, entry.base),
    adds = adds,
    dels = dels,
    unseen_lines = unseen,
    lines = lines,
  }
end
-- One page of the review's hunks. `mode` picks the projection ("combined", the
-- default, or "commits") independently of the scope the human is viewing, so an
-- agent can walk a review commit by commit without disturbing their buffer.
-- Order is the buffer's own (commit -> file -> hunk), and `cursor` is the id of
-- the last hunk emitted: pass it back to get the next page, and stop when the
-- returned cursor is nil.
function M.hunks(session, opts)
  opts = opts or {}
  local mode = opts.mode or "combined"
  if mode ~= "combined" and mode ~= "commits" then
    error(("glean: unknown hunk mode %q; expected \"combined\" or \"commits\"")
      :format(tostring(mode)), 0)
  end
  local s = M.session(session)
  local limit = opts.limit or 20
  local matches = glob_filter(opts.path)
  local out, total, cursor = {}, 0, nil
  for _, entry in ipairs(s:all_hunks(mode)) do
    if matches(entry.path) and not (opts.cursor and entry.id <= opts.cursor) then
      local hunk = api_hunk(s, entry)
      if opts.seen == nil or opts.seen == hunk.seen then
        total = total + 1
        if #out < limit then
          out[#out + 1] = hunk
          cursor = hunk.id
        end
      end
    end
  end
  return { hunks = out, cursor = total > #out and cursor or nil, total = total }
end
-- Resolve one selector — a hunk id, or `{ id, lines = {i, ...} }` — to the
-- identities it addresses, plus the combined-scope sticky records that keep an
-- explicit mark from being display-demoted. Unknown ids and out-of-range line
-- indices are caller bugs: they error rather than silently marking nothing.
local function selector_identities(s, index, sel)
  local id = type(sel) == "table" and sel.id or sel
  local entry = index[id]
  if not entry then
    error(("glean: no hunk with id %q in this review; re-list with hunks()")
      :format(tostring(id)), 0)
  end
  local indices = type(sel) == "table" and sel.lines or nil
  if not indices then
    indices = {}
    for i = 1, #entry.hunk.lines do indices[i] = i end
  end
  local ids, sticky = {}, {}
  for _, i in ipairs(indices) do
    local dl = entry.hunk.lines[i]
    if not dl then
      error(("glean: hunk %s has no line %s (it has %d)")
        :format(id, tostring(i), #entry.hunk.lines), 0)
    end
    local lid = s:line_identity(dl, entry.path, entry.owner, entry.base + i)
    if lid then
      ids[#ids + 1] = lid
      if entry.mode == "combined" then
        sticky[#sticky + 1] = { path = entry.path, text = dl.text }
      end
    end
  end
  return ids, sticky
end
-- Mark hunks (or individual lines within them) seen — the api mirror of `m` in
-- the buffer. `sel` is one selector or a list of them, each either a hunk id (the
-- whole hunk) or `{ id = <hunk id>, lines = { i, ... } }` (those `lines[].i`
-- values only, like a visual-mode mark). The whole batch is one `Session:perform`,
-- so an agent's pass undoes with a single `u`.
function M.mark(session, sel, seen)
  if seen == nil then seen = true end
  local s = M.session(session)
  local sels = (type(sel) == "string" or (type(sel) == "table" and sel.id)) and { sel } or sel
  if type(sels) ~= "table" or #sels == 0 then
    error("glean: mark requires a hunk id or a list of them", 0)
  end
  local mode = type(sels[1]) == "table" and sels[1].id or sels[1]
  mode = tostring(mode):sub(1, 1) == "c" and "commits" or "combined"
  local index = {}
  for _, entry in ipairs(s:all_hunks(mode)) do index[entry.id] = entry end
  local op = seen and "mark" or "unmark"
  local changed, sticky = {}, {}
  for _, one in ipairs(sels) do
    local ids, sticks = selector_identities(s, index, one)
    for _, id in ipairs(ids) do
      if (op == "mark") ~= s:id_seen(id) then changed[#changed + 1] = id end
    end
    for _, st in ipairs(sticks) do sticky[#sticky + 1] = st end
  end
  if #changed > 0 or #sticky > 0 then
    s:perform({ kind = "seen", op = op, ids = changed, sticky = sticky })
    s:render()
  end
  return { hunks = #sels, lines = #changed }
end

-- The stored record for `id` in this review, plus its path, or an error naming
-- the id. Never a silent no-op: an unknown id is a caller bug.
local function find_record(s, id)
  for _, pair in ipairs(s:comment_file_pairs()) do
    local path = pair.exact.path
    for _, rec in ipairs(s.store:comments_for(path)) do
      if rec.id == id then
        return vim.tbl_extend("force", rec, { path = path })
      end
    end
  end
  error(("glean: no comment with id %s in this review"):format(tostring(id)), 0)
end

-- Set the agent reply on a comment, replacing any previous one. The human's
-- `text` is never touched. Routed through `Session:perform`, so it undoes with
-- `u` in the buffer, persists through the normal save path, and re-renders.
function M.reply(session, id, text)
  if type(text) ~= "string" or text == "" then
    error("glean: reply text must be a non-empty string", 0)
  end
  local s = M.session(session)
  s:set_comment_reply(find_record(s, id), text)
  return true
end

-- Clear the agent reply on a comment (a no-op reply-to-nil, still undoable).
function M.unreply(session, id)
  local s = M.session(session)
  s:set_comment_reply(find_record(s, id), nil)
  return true
end

return M
