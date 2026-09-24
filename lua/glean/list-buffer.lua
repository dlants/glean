-- Log / PR list buffer UI.
local bridge = require("glean.rpc-bridge")
local util = require("glean.buffer-util")
local M = {}
-- Log / PR list buffer: `kind` is "log" or "prs". Selections and paging are
-- forwarded to node as one notify each.
M.open_list_buffer = function(kind, name)
  local buf = util.new_listed_buffer(name)
  local function list(ev)
    ev.buf = buf
    bridge.notify("gleanList", ev)
  end
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("n", "<CR>", function() list({ kind = "open", srow = util.row0(), erow = util.row0() }) end)
  map("n", "]p", function() list({ kind = "page", delta = 1 }) end)
  map("n", "q", function() util.close_if_current(buf) end)
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
  util.show_buffer(buf)
  return buf
end

return M
