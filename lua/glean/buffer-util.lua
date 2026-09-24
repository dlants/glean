-- Shared helpers for glean's listed buffers (review and list).
local M = {}
M.row0 = function()
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

M.new_listed_buffer = function(name)
  local buf = vim.api.nvim_create_buf(true, false)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "glean"
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, name)
  return buf
end

M.close_if_current = function(buf)
  local win = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(win) == buf then vim.api.nvim_win_close(win, true) end
end

return M
