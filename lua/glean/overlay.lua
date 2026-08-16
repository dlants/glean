-- glean.overlay: comments rendered into ordinary file buffers.
--
-- Modelled on diagnostics rather than on the glean buffer: a file buffer is the
-- user's editing surface, so comments show up as a sign, dimmed end-of-line
-- text and a float on demand, with inline bodies only behind an explicit
-- toggle.
--
-- A comment's position is never tracked. It is recomputed by resolving the
-- record's content against the buffer on every event that can change the text
-- (including an agent writing the file behind the buffer's back), which makes
-- the user-edit and external-write paths the same code and keeps extmarks a
-- pure rendering mechanism.
local api = vim.api
local comments = require("glean.comments")
local git = require("glean.git")

local M = {}

local ns = api.nvim_create_namespace("glean_overlay")
-- Per-buffer display mode: inline bodies (virt_lines) vs signs only.
local inline = {}

local EOL_WIDTH = 60

local function first_line(text)
  local line = (text or ""):match("^[^\n]*") or ""
  if #line > EOL_WIDTH then line = line:sub(1, EOL_WIDTH - 1) .. "…" end
  return line
end

-- The repo context and repo-relative path for a buffer, or nil when the buffer
-- is not a file in a git repo.
local function buf_target(bufnr)
  local ctx = comments.context(bufnr)
  if not ctx then return nil end
  local path = git.relpath(ctx.repo_root, api.nvim_buf_get_name(bufnr))
  if not path then return nil end
  return ctx, path
end

-- Resolve every record for `bufnr` against its current lines, persisting any
-- record whose resolved line moved. Returns a list of { lnum, records } groups
-- ordered by line, or nil when the buffer has no comments.
local function resolve_buffer(bufnr)
  local ctx, path = buf_target(bufnr)
  if not ctx then return nil end
  local records = comments.for_path(ctx, path)
  if #records == 0 then return nil, ctx, path end
  local lines = api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local last = math.max(#lines, 1)
  local by_lnum, moved = {}, false
  for _, record in ipairs(records) do
    local run = comments.file_projection(record)
    if #run > 0 then
      local loc = comments.locate(record, lines, nil, "file")
      local lnum = math.max(1, math.min(loc.lnum or 1, last))
      if record.lnum ~= lnum then
        record.lnum = lnum
        moved = true
      end
      local group = by_lnum[lnum]
      if not group then
        group = { lnum = lnum, records = {} }
        by_lnum[lnum] = group
      end
      group.records[#group.records + 1] = {
        record = record,
        outdated = loc.outdated,
        length = loc.outdated and 1 or #run,
      }
    end
  end
  if moved then comments.persist(ctx, path) end
  local out = {}
  for _, group in pairs(by_lnum) do out[#out + 1] = group end
  table.sort(out, function(a, b) return a.lnum < b.lnum end)
  return out, ctx, path
end

-- The body (and any agent reply) of a record, as display lines.
local function body_lines(record)
  local out = {}
  for _, line in ipairs(vim.split(record.text or "", "\n", { plain = true })) do
    out[#out + 1] = { text = line, hl = "GleanComment" }
  end
  if record.reply and record.reply ~= "" then
    for _, line in ipairs(vim.split(record.reply, "\n", { plain = true })) do
      out[#out + 1] = { text = "↳ " .. line, hl = "GleanCommentReply" }
    end
  end
  return out
end

local function stamp(bufnr, group, show_inline)
  local entries = group.records
  local head = entries[1]
  local all_outdated = true
  local length = 1
  for _, entry in ipairs(entries) do
    if not entry.outdated then all_outdated = false end
    length = math.max(length, entry.length)
  end
  local hl = all_outdated and "GleanCommentOutdated" or "GleanComment"
  local label = ("#%d %s"):format(head.record.id or 0, first_line(head.record.text))
  if #entries > 1 then label = label .. (" (+%d more)"):format(#entries - 1) end
  if all_outdated then label = label .. " (outdated)" end
  local opts = {
    sign_text = "💬",
    sign_hl_group = hl,
    virt_text = { { " " .. label, hl } },
    virt_text_pos = "eol",
    hl_mode = "combine",
  }
  if show_inline then
    local virt = {}
    for _, entry in ipairs(entries) do
      for _, line in ipairs(body_lines(entry.record)) do
        virt[#virt + 1] = { { "  " .. line.text, line.hl } }
      end
    end
    opts.virt_lines = virt
  end
  api.nvim_buf_set_extmark(bufnr, ns, group.lnum - 1, 0, opts)
  -- Make a multi-line comment's extent visible.
  if length > 1 then
    local total = api.nvim_buf_line_count(bufnr)
    for lnum = group.lnum, math.min(group.lnum + length - 1, total) do
      api.nvim_buf_set_extmark(bufnr, ns, lnum - 1, 0, { line_hl_group = "GleanCommentLine" })
    end
  end
end

-- Re-resolve and re-stamp every comment in `bufnr`. Cheap no-op for a buffer
-- with no comments: it never creates state, marks or mappings.
function M.refresh(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  if not api.nvim_buf_is_loaded(bufnr) then return end
  local groups = resolve_buffer(bufnr)
  if not groups then return end
  api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  local show_inline = inline[bufnr] == true
  for _, group in ipairs(groups) do stamp(bufnr, group, show_inline) end
end

-- Inline bodies versus signs only.
function M.toggle(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  inline[bufnr] = not inline[bufnr]
  api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  M.refresh(bufnr)
  return inline[bufnr] == true
end

-- Every record resolving to `lnum` in `bufnr`.
function M.at(bufnr, lnum)
  local groups = resolve_buffer(bufnr) or {}
  local out = {}
  for _, group in ipairs(groups) do
    if group.lnum == lnum then
      for _, entry in ipairs(group.records) do out[#out + 1] = entry.record end
    end
  end
  return out
end

-- Float the full body (and reply) of the cursor line's comments. Returns the
-- float's window id, or nil when the line carries no comment.
function M.show(bufnr, lnum)
  bufnr = bufnr or api.nvim_get_current_buf()
  lnum = lnum or api.nvim_win_get_cursor(0)[1]
  local records = M.at(bufnr, lnum)
  if #records == 0 then return nil end
  local lines, highlights = {}, {}
  for _, record in ipairs(records) do
    if #lines > 0 then lines[#lines + 1] = "" end
    lines[#lines + 1] = ("#%d"):format(record.id or 0)
    highlights[#lines] = "GleanCommentId"
    for _, line in ipairs(body_lines(record)) do
      lines[#lines + 1] = line.text
      highlights[#lines] = line.hl
    end
  end
  local float = api.nvim_create_buf(false, true)
  api.nvim_buf_set_lines(float, 0, -1, false, lines)
  for row, hl in pairs(highlights) do
    api.nvim_buf_set_extmark(float, ns, row - 1, 0, { end_row = row, hl_group = hl })
  end
  vim.bo[float].modifiable = false
  local width = 1
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line)) end
  local win = api.nvim_open_win(float, false, {
    relative = "cursor", row = 1, col = 0,
    width = math.min(width + 1, 80), height = math.min(#lines, 12),
    style = "minimal", border = "rounded",
  })
  api.nvim_create_autocmd({ "CursorMoved", "BufLeave", "InsertEnter" }, {
    once = true,
    callback = function()
      if api.nvim_win_is_valid(win) then api.nvim_win_close(win, true) end
    end,
  })
  return win
end

-- Every comment in the repo, resolved against the working tree, as a quickfix
-- list. A record with no file projection (a del-only selection) has no file
-- position, so it is listed at its stored lnum and marked outdated rather than
-- dropped.
function M.quickfix(ctx)
  ctx = ctx or comments.context(0)
  if not ctx then
    vim.notify("glean: not inside a git repository", vim.log.levels.WARN)
    return {}
  end
  local store = comments.store(ctx)
  local items = {}
  for _, path in ipairs(store:comment_paths()) do
    local full = ctx.repo_root .. "/" .. path
    local lines = vim.fn.filereadable(full) == 1 and vim.fn.readfile(full) or nil
    for _, record in ipairs(store:comments_for(path)) do
      local lnum, outdated = record.lnum or 1, true
      if lines and #comments.file_projection(record) > 0 then
        local loc = comments.locate(record, lines, nil, "file")
        lnum = math.max(1, math.min(loc.lnum or 1, math.max(#lines, 1)))
        outdated = loc.outdated
      end
      items[#items + 1] = {
        filename = full,
        lnum = lnum,
        text = ("#%d %s%s"):format(record.id or 0, first_line(record.text),
          outdated and " (outdated)" or ""),
      }
    end
  end
  vim.fn.setqflist({}, " ", { title = "glean comments", items = items })
  return items
end

-- Refresh every loaded buffer whose comments live under `dir`.
local function refresh_dir(dir)
  for _, bufnr in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(bufnr) then
      local ctx = comments.context(bufnr)
      if ctx and (dir == nil or ctx.dir == dir) then M.refresh(bufnr) end
    end
  end
end

function M.setup(cfg)
  M.config = vim.tbl_extend("force", M.config or {}, cfg or {})
  local group = api.nvim_create_augroup("GleanOverlay", { clear = true })
  api.nvim_create_autocmd({ "BufReadPost", "FileChangedShellPost", "BufWritePost" }, {
    group = group,
    callback = function(args) M.refresh(args.buf) end,
  })
  api.nvim_create_autocmd("User", {
    group = group,
    pattern = "GleanCommentsChanged",
    callback = function(args)
      local dir = args.data and args.data.dir
      -- A change the registry itself made is already in memory; only another
      -- surface's write (a session's store) needs a re-read from disk.
      if dir and (args.data.source ~= "registry") then comments.invalidate(dir) end
      refresh_dir(dir)
    end,
  })
end

return M
