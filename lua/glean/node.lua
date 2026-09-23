-- Lua half of the node backend: start the process, bridge its channel back
-- into commands/autocmds, and tear everything down when node goes away. Every
-- handler here is O(1) plus one rpcnotify; all real work happens in node.
local M = {}

M.command_name = "Glean"

M.teardown_bridge = function(reason, expected)
  local had_bridge = M.channel_id ~= nil or M.bridge_augroup ~= nil
  if M.bridge_augroup then
    pcall(vim.api.nvim_del_augroup_by_id, M.bridge_augroup)
    M.bridge_augroup = nil
  end
  pcall(vim.api.nvim_del_user_command, M.command_name)
  if had_bridge then pcall(require("glean.node_gutter").teardown) end
  M.channel_id = nil
  vim.g.glean_node_channel = nil
  if had_bridge and not expected then
    vim.notify("glean: backend exited (" .. tostring(reason or "unknown") .. ")", vim.log.levels.WARN)
  end
end

local function node_job_alive()
  if not M.job_id then
    return false
  end
  local ok, result = pcall(vim.fn.jobwait, { M.job_id }, 0)
  return ok and result[1] == -1
end

local function channel_alive(channel_id)
  local ok, info = pcall(vim.api.nvim_get_chan_info, channel_id)
  return ok and type(info) == "table" and info.id ~= nil
end

-- Returns false (and tears down the bridge if node is really gone) instead of
-- raising, so a dead backend never breaks the editing session.
M.safe_rpcnotify = function(channel_id, method, ...)
  if not channel_id or M.channel_id ~= channel_id then
    M.teardown_bridge("channel mismatch (method=" .. tostring(method) .. ")")
    return false
  end
  local ok, err = pcall(vim.rpcnotify, channel_id, method, ...)
  if not ok then
    if node_job_alive() and channel_alive(channel_id) then
      vim.notify("glean: rpcnotify failed (" .. tostring(err) .. ")", vim.log.levels.WARN)
      return false
    end
    M.teardown_bridge("rpcnotify failed: " .. tostring(err))
  end
  return ok
end

local function plugin_root()
  local file = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(file, ":p:h:h:h") .. "/"
end

-- Default: the prebuilt bundle. GLEAN_DEV=1 (or a missing bundle) runs the
-- TypeScript source directly.
M.start = function()
  local root = plugin_root()
  local bundle = root .. "dist/glean.mjs"
  local cmd
  if vim.env.GLEAN_DEV == "1" or vim.uv.fs_stat(bundle) == nil then
    cmd = {
      "node",
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      "--import", root .. "node/boot.mjs",
      root .. "node/index.ts",
    }
  else
    cmd = { "node", bundle }
  end
  local env = vim.fn.environ()
  env.LOG_LEVEL = env.GLEAN_LOG_LEVEL or "info"
  -- An inherited $NVIM (e.g. nvim started from a :terminal) would point node
  -- at the wrong instance.
  env.NVIM = vim.v.servername ~= "" and vim.v.servername or vim.fn.serverstart()
  M.job_id = vim.fn.jobstart(cmd, {
    cwd = root,
    stdin = "null",
    env = env,
    on_exit = function(_, code)
      M.teardown_bridge("node exited with code " .. tostring(code))
    end,
  })
  if M.job_id <= 0 then
    vim.notify("glean: failed to start node backend (" .. tostring(M.job_id) .. ")", vim.log.levels.ERROR)
  end
  return M.job_id
end

-- Called by node once it has attached.
M.bridge = function(channel_id)
  M.teardown_bridge("re-registering bridge", true)
  M.channel_id = channel_id
  vim.g.glean_node_channel = channel_id
  M.bridge_augroup = vim.api.nvim_create_augroup("GleanBridge", { clear = true })

  vim.api.nvim_create_user_command(M.command_name, function(opts)
    -- toggle-mark acts on the current file buffer, so it carries the range.
    if opts.fargs[1] == "toggle-mark" then
      local ev = { kind = "toggle-mark", buf = vim.api.nvim_get_current_buf() }
      if opts.range > 0 then
        ev.line1, ev.line2 = opts.line1, opts.line2
      else
        ev.line1 = vim.api.nvim_win_get_cursor(0)[1]
      end
      M.safe_rpcnotify(channel_id, "gleanGutter", ev)
      return
    end
    M.safe_rpcnotify(channel_id, "gleanCommand", opts.fargs)
  end, {
    nargs = "*",
    range = true,
    desc = "glean: open a review or run a subcommand",
    complete = function(lead)
      local out = {}
      for _, sub in ipairs({ "comment", "comments", "toggle-mark", "toggle-gutter", "jump", "log",
        "prs", "pr", "branch" }) do
        if sub:sub(1, #lead) == lead then out[#out + 1] = sub end
      end
      return out
    end,
  })
  require("glean.node_gutter").bridge(M.bridge_augroup)

  -- Stop node early in shutdown so nvim doesn't wait out SIGTERM->SIGKILL.
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = M.bridge_augroup,
    callback = function()
      if M.job_id then
        pcall(vim.fn.jobstop, M.job_id)
      end
      M.teardown_bridge("VimLeavePre", true)
    end,
  })
end

local function action(buf, a)
  M.safe_rpcnotify(M.channel_id, "gleanAction", buf, a)
end

local function row0()
  return vim.api.nvim_win_get_cursor(0)[1] - 1
end

-- Focus a window showing `buf`, else put it in the current window (or a
-- vertical split when the current one is a float or shares its column).
M.show_buffer = function(buf)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf then
      vim.api.nvim_set_current_win(win)
      return win
    end
  end
  if vim.api.nvim_win_get_config(0).relative ~= ""
    or vim.fn.winnr("k") ~= vim.fn.winnr()
    or vim.fn.winnr("j") ~= vim.fn.winnr()
  then
    vim.cmd("botright vsplit")
  end
  local win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(win, buf)
  return win
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
-- `spec.lines` nil reuses the existing buffer called `spec.name`.
local function scratch(spec)
  if spec.lines == nil or spec.lines == vim.NIL then
    local b = vim.fn.bufnr(spec.name)
    if b ~= -1 then return b end
    spec.lines = {}
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, spec.lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = spec.bufhidden
  local ft = vim.filetype.match({ filename = spec.path, contents = spec.lines })
  if ft then vim.bo[buf].filetype = ft end
  pcall(vim.api.nvim_buf_set_name, buf, spec.name)
  return buf
end
M.open_scratch_at = function(win, spec, lnum, col)
  local buf = scratch(spec)
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
-- (post-image). `right.abs` opens the live file, else `right.fallback`/`right`
-- is a scratch spec.
M.diffsplit = function(win, right, post_lnum, left, pre_lnum, iwhite)
  focus(win)
  vim.cmd("rightbelow vsplit")
  local right_win = vim.api.nvim_get_current_win()
  if right.abs and vim.fn.filereadable(right.abs) == 1 then
    vim.cmd("edit " .. vim.fn.fnameescape(right.abs))
  else
    vim.api.nvim_win_set_buf(right_win, scratch(right.fallback or right))
  end
  if post_lnum ~= vim.NIL then pcall(vim.api.nvim_win_set_cursor, right_win, { post_lnum, 0 }) end
  vim.cmd("diffthis")
  vim.cmd("leftabove vsplit")
  local left_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(left_win, scratch(left))
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
local function query(buf, q)
  local ok, res = pcall(vim.rpcrequest, M.channel_id, "gleanQuery", buf, q)
  if ok and res ~= vim.NIL then return res end
  return nil
end
local function new_listed_buffer(name)
  local buf = vim.api.nvim_create_buf(true, false)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "glean"
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, name)
  return buf
end

local function close_if_current(buf)
  local win = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(win) == buf then vim.api.nvim_win_close(win, true) end
end

-- Log / PR list buffer: `kind` is "log" or "prs". Selections and paging are
-- forwarded to node as one notify each.
M.open_list_buffer = function(kind, name)
  local buf = new_listed_buffer(name)
  local function list(ev)
    ev.buf = buf
    M.safe_rpcnotify(M.channel_id, "gleanList", ev)
  end
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("n", "<CR>", function() list({ kind = "open", srow = row0(), erow = row0() }) end)
  map("n", "]p", function() list({ kind = "page", delta = 1 }) end)
  map("n", "q", function() close_if_current(buf) end)
  if kind == "log" then
    map("x", "<CR>", function()
      local s, e = vim.fn.line("v") - 1, vim.fn.line(".") - 1
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
      list({ kind = "open", srow = s, erow = e })
    end)
  else
    map("n", "[p", function() list({ kind = "page", delta = -1 }) end)
  end
  vim.api.nvim_create_autocmd("BufReadCmd", {
    buffer = buf,
    callback = function() list({ kind = "reload" }) end,
  })
  vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    buffer = buf,
    callback = function() list({ kind = "gone" }) end,
  })
  M.show_buffer(buf)
  return buf
end

-- Review buffer; each keymap is one rpcnotify with the cursor row.
-- `title` leads with the api session id so agents can read it off.
M.open_review_buffer = function(title)
  local buf = new_listed_buffer(title)
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("n", "m", function() action(buf, { kind = "toggle-seen", row = row0() }) end)
  map("n", "=", function() action(buf, { kind = "toggle-fold", row = row0() }) end)
  map("n", "S", function() action(buf, { kind = "toggle-scope", row = row0() }) end)
  map("n", "<CR>", function()
    action(buf, { kind = "jump", row = row0(), col = vim.api.nvim_win_get_cursor(0)[2] })
  end)
  map("n", "D", function() action(buf, { kind = "diffsplit", row = row0() }) end)
  map("n", "q", function() close_if_current(buf) end)
  for lhs, nav in pairs({
    ["]c"] = { unit = "hunk", forward = true }, ["[c"] = { unit = "hunk", forward = false },
    ["]f"] = { unit = "file", forward = true }, ["[f"] = { unit = "file", forward = false },
  }) do
    map({ "n", "x" }, lhs, function()
      local r = query(buf, { kind = "nav", row = row0(), unit = nav.unit, forward = nav.forward })
      if r then move_to_hunk_row(r[1], r[2]) end
    end)
  end
  -- Linewise-select the hunk: composes in visual (`vac`) and operator-pending
  -- (`dac`) mode, so the range is fetched synchronously.
  map({ "x", "o" }, "ac", function()
    local r = query(buf, { kind = "hunk-range", row = row0() })
    if not r then return end
    if vim.api.nvim_get_mode().mode:match("[vV\22]") then
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    end
    vim.api.nvim_win_set_cursor(0, { r[1] + 1, 0 })
    vim.cmd("normal! V")
    vim.api.nvim_win_set_cursor(0, { r[2] + 1, 0 })
  end)
  map("x", "d", function()
    local s, e = vim.fn.line("v") - 1, vim.fn.line(".") - 1
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
    action(buf, { kind = "delete-comments", srow = s, erow = e })
  end)
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
    callback = function() action(buf, { kind = "visibility", visible = true }) end,
  })
  vim.api.nvim_create_autocmd("BufWinLeave", {
    group = group, buffer = buf,
    callback = function() action(buf, { kind = "visibility", visible = false }) end,
  })
  vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    group = group, buffer = buf,
    callback = function() action(buf, { kind = "gone" }) end,
  })
  M.show_buffer(buf)
  return buf
end

return M
