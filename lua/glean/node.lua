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
  map("n", "<CR>", function() action(buf, { kind = "reveal-comment", row = row0() }) end)
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
