-- Lua half of the file-buffer comment overlay (node/overlay/). Node resolves,
-- stamps and edits comments; this module forwards events, installs the
-- `<Plug>` mappings and draws the float node asks for.
local api = vim.api
local M = {}
M.config = {}
local function notify(ev)
  local node = require("glean.rpc-bridge")
  return node.notify("gleanOverlay", ev)
end
M.notify = notify
local function cur() return api.nvim_get_current_buf(), api.nvim_win_get_cursor(0)[1] end
function M.add_range(line1, line2)
  notify({ kind = "add", buf = api.nvim_get_current_buf(), line1 = line1, line2 = line2 })
end
local function at(kind)
  return function()
    local buf, lnum = cur()
    notify({ kind = kind, buf = buf, lnum = lnum })
  end
end
local function jump(dir)
  return function()
    local buf, lnum = cur()
    notify({ kind = "jump", buf = buf, lnum = lnum, dir = dir })
  end
end
local PLUGS = {
  { "(glean-comment)", { "n", "x" }, function()
    local mode = api.nvim_get_mode().mode
    if mode:match("^[vV\22]") then
      local a, b = vim.fn.line("v"), vim.fn.line(".")
      api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
      M.add_range(math.min(a, b), math.max(a, b))
    else
      local _, lnum = cur()
      M.add_range(lnum, lnum)
    end
  end },
  { "(glean-comment-show)", { "n" }, at("show") },
  { "(glean-comment-edit)", { "n" }, at("edit") },
  { "(glean-comment-delete)", { "n" }, at("delete") },
  { "(glean-comment-reply)", { "n" }, at("reply") },
  { "(glean-comment-next)", { "n" }, jump(1) },
  { "(glean-comment-prev)", { "n" }, jump(-1) },
  { "(glean-comment-toggle)", { "n" }, function() notify({ kind = "toggle", buf = api.nvim_get_current_buf() }) end },
}
local PREFIXED = {
  { "(glean-comment)", "c", { "n", "x" } },
  { "(glean-comment-show)", "s", { "n" } },
  { "(glean-comment-edit)", "e", { "n" } },
  { "(glean-comment-delete)", "d", { "n" } },
  { "(glean-comment-reply)", "r", { "n" } },
  { "(glean-comment-next)", "n", { "n" } },
  { "(glean-comment-prev)", "p", { "n" } },
  { "(glean-comment-toggle)", "t", { "n" } },
}
--- `overlay_keymaps = "<prefix>"` wires the defaults under a prefix; a file
--- buffer is the user's editing surface, so otherwise only `<Plug>` maps exist.
function M.setup(cfg)
  M.config = vim.tbl_extend("force", M.config, cfg or {})
  for _, spec in ipairs(PLUGS) do
    vim.keymap.set(spec[2], "<Plug>" .. spec[1], spec[3], { silent = true })
  end
  local prefix = M.config.overlay_keymaps
  if type(prefix) == "string" and prefix ~= "" then
    for _, spec in ipairs(PREFIXED) do
      vim.keymap.set(spec[3], prefix .. spec[2], "<Plug>" .. spec[1], { silent = true })
    end
  end
end
--- Installed by the bridge.
function M.bridge(group)
  api.nvim_create_autocmd({ "BufReadPost", "FileChangedShellPost", "BufWritePost" }, {
    group = group,
    callback = function(args) notify({ kind = "refresh", buf = args.buf }) end,
  })
  api.nvim_create_autocmd("BufWipeout", {
    group = group,
    callback = function(args)
      if vim.g.glean_node_channel then notify({ kind = "wipe", buf = args.buf }) end
    end,
  })
end
--- The comment float at the cursor; closes on the next move. Returns its window.
function M.float(lines, hls)
  local ns = api.nvim_create_namespace("glean_overlay")
  local fbuf = api.nvim_create_buf(false, true)
  api.nvim_buf_set_lines(fbuf, 0, -1, false, lines)
  for i, hl in ipairs(hls) do
    if hl ~= "" then api.nvim_buf_set_extmark(fbuf, ns, i - 1, 0, { end_row = i, hl_group = hl }) end
  end
  vim.bo[fbuf].modifiable = false
  vim.bo[fbuf].bufhidden = "wipe"
  local width = 1
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line)) end
  local win = api.nvim_open_win(fbuf, false, {
    relative = "cursor", row = 1, col = 0,
    width = math.min(width + 1, 80), height = math.min(#lines, 12),
    style = "minimal", border = "rounded",
  })
  vim.w[win].glean_overlay_float = true
  api.nvim_create_autocmd({ "CursorMoved", "BufLeave", "InsertEnter" }, {
    once = true,
    callback = function()
      if api.nvim_win_is_valid(win) then api.nvim_win_close(win, true) end
    end,
  })
  return win
end
return M
