-- Comment prompts (editor split, picker) for the review buffer and overlay.
local bridge = require("glean.rpc-bridge")
local M = {}
-- Results go to node's shared prompt table, keyed by token.
local function reply(ev)
  bridge.notify("gleanPrompt", ev)
end
-- Ephemeral multi-line comment editor in a split above `win` (port of the old
-- `comments.open_editor`). `:w` or normal `<CR>` submits, `q`/`<C-c>` cancel;
-- the text returns to node as one `editor-submit` action.
M.comment_editor = function(win, initial, token)
  local api = vim.api
  local ebuf = api.nvim_create_buf(false, true)
  vim.bo[ebuf].buftype = "acwrite"
  vim.bo[ebuf].bufhidden = "wipe"
  vim.bo[ebuf].filetype = "markdown"
  pcall(api.nvim_buf_set_name, ebuf, "glean-comment://" .. ebuf)
  local seed = #initial > 0 and initial or { "" }
  api.nvim_buf_set_lines(ebuf, 0, -1, false, seed)
  if win and win > 0 and api.nvim_win_is_valid(win) then api.nvim_set_current_win(win) end
  vim.cmd("aboveleft split")
  local ewin = api.nvim_get_current_win()
  api.nvim_win_set_buf(ewin, ebuf)
  api.nvim_win_set_height(ewin, math.max(5, math.min(15, #seed + 1)))
  local done = false
  local function finish(submit)
    if done then return end
    done = true
    local text = submit and table.concat(api.nvim_buf_get_lines(ebuf, 0, -1, false), "\n") or nil
    if api.nvim_win_is_valid(ewin) then pcall(api.nvim_win_close, ewin, true) end
    -- A cancelled or blank editor reports back without text, so node drops the prompt.
    if text and text:match("%S") then
      reply({ kind = "editor-submit", token = token, text = text })
    else
      reply({ kind = "editor-submit", token = token })
    end
  end
  api.nvim_create_autocmd("BufWriteCmd", { buffer = ebuf, callback = function() finish(true) end })
  local o = { buffer = ebuf, nowait = true, silent = true }
  vim.keymap.set("n", "<CR>", function() finish(true) end, o)
  vim.keymap.set("n", "q", function() finish(false) end, o)
  vim.keymap.set("n", "<C-c>", function() finish(false) end, { buffer = ebuf, silent = true })
  -- A new comment drops into insert; an edit starts in normal mode.
  if #initial > 0 then
    pcall(api.nvim_win_set_cursor, ewin, { #seed, 0 })
  else
    vim.cmd("startinsert")
  end
end

-- `dc` with several comments on the line: the user picks which to delete.
M.pick_comment = function(choices, token, prompt)
  vim.schedule(function()
    vim.ui.select(choices, { prompt = prompt or "glean: delete comment" }, function(_, idx)
      reply({ kind = "pick", token = token, index = idx and idx - 1 or nil })
    end)
  end)
end

return M
