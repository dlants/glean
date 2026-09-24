-- Lua half of the node backend: start the process, bridge its channel back
-- into commands/autocmds, and tear everything down when node goes away. Every
-- handler here is O(1) plus one M.notify; all real work happens in node.
local M = {}

M.command_name = "Glean"

M.teardown_bridge = function(reason, expected)
  local had_bridge = M.channel_id ~= nil or M.bridge_augroup ~= nil
  if M.bridge_augroup then
    pcall(vim.api.nvim_del_augroup_by_id, M.bridge_augroup)
    M.bridge_augroup = nil
  end
  pcall(vim.api.nvim_del_user_command, M.command_name)
  if had_bridge then pcall(require("glean.gutter").teardown) end
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

-- The single pathway to node. A failed send against a dead backend tears the
-- bridge down, so every caller participates in teardown the same way.
local function send(rpc, method, ...)
  local chan = M.channel_id
  if not chan then return false, "glean: the backend is not running" end
  local ok, res = pcall(rpc, chan, method, ...)
  if not ok and not (node_job_alive() and channel_alive(chan)) then
    M.teardown_bridge(tostring(method) .. " failed: " .. tostring(res))
  end
  return ok, res
end
-- Fire-and-forget; returns false instead of raising, so a dead backend never
-- breaks the editing session.
M.notify = function(method, ...)
  local ok, err = send(vim.rpcnotify, method, ...)
  if not ok and M.channel_id then
    vim.notify("glean: rpcnotify failed (" .. tostring(err) .. ")", vim.log.levels.WARN)
  end
  return ok
end
-- Raises on failure (including node-side errors); vim.NIL results become nil.
M.request = function(method, ...)
  local ok, res = send(vim.rpcrequest, method, ...)
  if not ok then error(tostring(res), 0) end
  if res == vim.NIL then return nil end
  return res
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
      M.notify("gleanGutter", ev)
      return
    end
    if opts.fargs[1] == "comment" then
      local line1, line2 = opts.line1, opts.line2
      if opts.range == 0 then
        line1 = vim.api.nvim_win_get_cursor(0)[1]
        line2 = line1
      end
      require("glean.overlay").add_range(line1, line2)
      return
    end
    if opts.fargs[1] == "comments" then
      M.notify("gleanOverlay", { kind = "quickfix", buf = vim.api.nvim_get_current_buf() })
      return
    end
    M.notify("gleanCommand", opts.fargs)
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
  require("glean.gutter").bridge(M.bridge_augroup)
  require("glean.overlay").bridge(M.bridge_augroup)

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

return M
