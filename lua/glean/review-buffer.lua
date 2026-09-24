-- Review buffer UI: keymaps and autocmds (each one notify with the cursor row)
-- plus the jump/diffsplit/cursor helpers node drives via exec_lua.
local bridge = require("glean.rpc-bridge")
local util = require("glean.buffer-util")
local M = {}
local function action(buf, a)
  bridge.notify("gleanReview", buf, a)
end

local function set_cursor_clamped(win, lnum, col)
  local buf = vim.api.nvim_win_get_buf(win)
  local n = vim.api.nvim_buf_line_count(buf)
  lnum = math.max(1, math.min(lnum, n))
  local text = vim.api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1]
  if text then col = math.max(0, math.min(col, #text - 1)) end
  pcall(vim.api.nvim_win_set_cursor, win, { lnum, col })
end
local function focus(win)
  if win and win > 0 and vim.api.nvim_win_is_valid(win) then
    vim.api.nvim_set_current_win(win)
  end
end
-- Jump helpers, driven by node (`node/view/jump.ts`).
M.open_file_at = function(win, abs, lnum, col)
  if vim.fn.filereadable(abs) ~= 1 then return false end
  focus(win)
  vim.cmd("edit " .. vim.fn.fnameescape(abs))
  set_cursor_clamped(0, lnum, col)
  return true
end
-- An empty read-only scratch named `spec.name`; node streams its lines in.
-- With `spec.reuse`, an existing buffer of that name is returned as is.
M.scratch_buf = function(spec)
  if spec.reuse then
    local b = vim.fn.bufnr(spec.name)
    if b ~= -1 then return { buf = b, created = false } end
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].modifiable = false
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = spec.bufhidden
  local ft = vim.filetype.match({ filename = spec.path, buf = buf })
  if ft then vim.bo[buf].filetype = ft end
  pcall(vim.api.nvim_buf_set_name, buf, spec.name)
  return { buf = buf, created = true }
end
M.open_scratch_at = function(win, buf, lnum, col)
  focus(win)
  vim.api.nvim_win_set_buf(0, buf)
  set_cursor_clamped(0, lnum, col)
  return buf
end
-- `iwhiteall` is added to 'diffopt' while any ignore-whitespace split is open,
-- and removed again only if glean added it.
local diff_ws = { count = 0, inserted = false }
local function acquire_diff_whitespace()
  if diff_ws.count == 0 then
    diff_ws.inserted = not vim.tbl_contains(vim.split(vim.o.diffopt, ","), "iwhiteall")
    if diff_ws.inserted then vim.o.diffopt = vim.o.diffopt .. ",iwhiteall" end
  end
  diff_ws.count = diff_ws.count + 1
  local released = false
  return function()
    if released then return end
    released = true
    diff_ws.count = math.max(0, diff_ws.count - 1)
    if diff_ws.count == 0 and diff_ws.inserted then
      local kept = vim.tbl_filter(function(p) return p ~= "iwhiteall" end,
        vim.split(vim.o.diffopt, ","))
      vim.o.diffopt = table.concat(kept, ",")
      diff_ws.inserted = false
    end
  end
end
-- Split diff right of the review window: `left` (pre-image) | `right`
-- (post-image). `right.abs` opens the live file, else `right.buf` is a scratch.
M.diffsplit = function(win, right, post_lnum, left, pre_lnum, iwhite)
  focus(win)
  vim.cmd("rightbelow vsplit")
  local right_win = vim.api.nvim_get_current_win()
  if right.abs then
    vim.cmd("edit " .. vim.fn.fnameescape(right.abs))
  else
    vim.api.nvim_win_set_buf(right_win, right.buf)
  end
  if post_lnum ~= vim.NIL then pcall(vim.api.nvim_win_set_cursor, right_win, { post_lnum, 0 }) end
  vim.cmd("diffthis")
  vim.cmd("leftabove vsplit")
  local left_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(left_win, left)
  if pre_lnum ~= vim.NIL then pcall(vim.api.nvim_win_set_cursor, left_win, { pre_lnum, 0 }) end
  vim.cmd("diffthis")
  vim.api.nvim_set_current_win(right_win)
  if iwhite then
    local release = acquire_diff_whitespace()
    vim.cmd("diffupdate")
    local group = vim.api.nvim_create_augroup("glean_diff_whitespace_" .. left_win .. "_" .. right_win,
      { clear = true })
    vim.api.nvim_create_autocmd("WinClosed", {
      group = group,
      callback = function(ev)
        local closed = tonumber(ev.match)
        if closed ~= left_win and closed ~= right_win then return end
        release()
        pcall(vim.api.nvim_del_augroup_by_id, group)
      end,
    })
  end
  return { right_win, left_win }
end
-- Park on a hunk header and scroll down (never up, never past the header) so
-- as much of the hunk as fits is visible: the old `move_to_hunk_row`.
local function move_to_hunk_row(row, last)
  local win = vim.api.nvim_get_current_win()
  pcall(vim.api.nvim_win_set_cursor, win, { row + 1, 0 })
  local view = vim.fn.winsaveview()
  local height = vim.api.nvim_win_get_height(win)
  local top = view.topline - 1
  if last > top + height - 1 then
    view.topline = math.max(top, math.min(last - height + 1, row)) + 1
    vim.fn.winrestview(view)
  end
end
-- The window displaying `buf` (the current one when it does) and its view
-- geometry, or nil when the review is on no window.
M.cursor_info = function(buf)
  local win = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(win) ~= buf then
    win = vim.fn.bufwinid(buf)
    if win == -1 then return nil end
  end
  local info = vim.fn.getwininfo(win)[1] or {}
  return {
    win = win,
    row = vim.api.nvim_win_get_cursor(win)[1] - 1,
    top = vim.fn.line("w0", win) - 1,
    width = vim.api.nvim_win_get_width(win),
    textoff = info.textoff or 0,
  }
end
local function query(buf, q)
  local ok, res = pcall(bridge.request, "gleanReviewQuery", buf, q)
  if ok then return res end
  return nil
end
-- Review buffer; each keymap is one rpcnotify with the cursor row.
-- `title` leads with the api session id so agents can read it off.
M.open_review_buffer = function(title)
  local buf = util.new_listed_buffer(title)
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("n", "m", function() action(buf, { kind = "toggle-seen", row = util.row0() }) end)
  map("n", "=", function() action(buf, { kind = "toggle-fold", row = util.row0() }) end)
  map("n", "S", function() action(buf, { kind = "toggle-scope", row = util.row0() }) end)
  map("n", "<CR>", function()
    action(buf, { kind = "jump", row = util.row0(), col = vim.api.nvim_win_get_cursor(0)[2] })
  end)
  map("n", "D", function() action(buf, { kind = "diffsplit", row = util.row0() }) end)
  map("n", "q", function() util.close_if_current(buf) end)
  for lhs, nav in pairs({
    ["]c"] = { unit = "hunk", forward = true }, ["[c"] = { unit = "hunk", forward = false },
    ["]f"] = { unit = "file", forward = true }, ["[f"] = { unit = "file", forward = false },
  }) do
    map({ "n", "x" }, lhs, function()
      local r = query(buf, { kind = "nav", row = util.row0(), unit = nav.unit, forward = nav.forward })
      if r then move_to_hunk_row(r[1], r[2]) end
    end)
  end
  -- Linewise-select the hunk: composes in visual (`vac`) and operator-pending
  -- (`dac`) mode, so the range is fetched synchronously.
  map({ "x", "o" }, "ac", function()
    local r = query(buf, { kind = "hunk-range", row = util.row0() })
    if not r then return end
    if vim.api.nvim_get_mode().mode:match("[vV\22]") then
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    end
    vim.api.nvim_win_set_cursor(0, { r[1] + 1, 0 })
    vim.cmd("normal! V")
    vim.api.nvim_win_set_cursor(0, { r[2] + 1, 0 })
  end)
  map("n", "c", function() action(buf, { kind = "add-comment", srow = util.row0(), erow = util.row0() }) end)
  map("x", "c", function()
    local s, e = vim.fn.line("v") - 1, vim.fn.line(".") - 1
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    action(buf, { kind = "add-comment", srow = s, erow = e })
  end)
  map("n", "i", function() action(buf, { kind = "edit-comment", row = util.row0() }) end)
  map("n", "e", function() action(buf, { kind = "edit-comment", row = util.row0() }) end)
  map("n", "dd", function() action(buf, { kind = "delete-comment", row = util.row0() }) end)
  map("n", "dc", function() action(buf, { kind = "delete-comment-at", row = util.row0() }) end)
  map("x", "d", function()
    local s, e = vim.fn.line("v") - 1, vim.fn.line(".") - 1
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
    action(buf, { kind = "delete-comments", srow = s, erow = e })
  end)
  map("n", "M", function() action(buf, { kind = "unmark-hunk", row = util.row0() }) end)
  map("n", "U", function() action(buf, { kind = "unmark-all" }) end)
  map("n", "W", function() action(buf, { kind = "toggle-whitespace", row = util.row0() }) end)
  map("n", "u", function() action(buf, { kind = "undo" }) end)
  map("n", "<C-r>", function() action(buf, { kind = "redo" }) end)
  map("x", "m", function()
    local s, e = vim.fn.line("v") - 1, vim.fn.line(".") - 1
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
    action(buf, { kind = "visual-mark", srow = s, erow = e })
  end)
  -- BufWinLeave fires only when the buffer leaves its last window.
  local group = vim.api.nvim_create_augroup("GleanReview" .. buf, { clear = true })
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = group, buffer = buf,
    callback = function()
      -- Keep the cursor clear of the sticky float (at most 4 pinned rows); the
      -- sign column carries the active hunk's bar.
      local win = vim.api.nvim_get_current_win()
      vim.wo[win].scrolloff = 4
      vim.wo[win].signcolumn = "yes:1"
      action(buf, { kind = "visibility", visible = true })
    end,
  })
  -- The float pins to the topline, so scrolling drives it as well as the
  -- cursor; node re-reads the window state (`cursor_info`) on each event.
  local function decor() action(buf, { kind = "cursor" }) end
  vim.api.nvim_create_autocmd({ "CursorMoved", "WinScrolled" }, {
    group = group, buffer = buf, callback = decor,
  })
  vim.api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, {
    group = group, buffer = buf,
    callback = function() action(buf, { kind = "sticky-close" }) end,
  })
  -- A buffer swapped into the review window (or the review shown again, or a
  -- resize) fires none of this buffer's events: re-evaluate on every switch;
  -- node closes the float when no window shows the review.
  vim.api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "WinEnter", "WinResized", "VimResized" }, {
    group = group, callback = decor,
  })
  -- `:e` is a hard reset: node rebuilds the session in this buffer.
  vim.api.nvim_create_autocmd("BufReadCmd", {
    group = group, buffer = buf,
    -- The row is read here: `:e` moves the cursor once the autocmd returns.
    callback = function()
      local win = vim.fn.bufwinid(buf)
      local row = win ~= -1 and vim.api.nvim_win_get_cursor(win)[1] - 1 or nil
      action(buf, { kind = "reset", row = row })
    end,
  })
  vim.api.nvim_create_autocmd("BufWinLeave", {
    group = group, buffer = buf,
    callback = function() action(buf, { kind = "visibility", visible = false }) end,
  })
  vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    group = group, buffer = buf,
    callback = function()
      action(buf, { kind = "gone" })
      vim.schedule(function() pcall(vim.api.nvim_del_augroup_by_id, group) end)
    end,
  })
  util.show_buffer(buf)
  return buf
end

return M
