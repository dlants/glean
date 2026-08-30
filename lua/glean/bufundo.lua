-- glean.bufundo: an undo/redo layer for actions taken *in an ordinary file
-- buffer* that change no text — comments (glean.overlay) and seen-marks
-- (glean.gutter).
--
-- The layer sits on top of the buffer's own undo tree rather than beside it:
-- `u` spends the glean stack first and then falls through to text undo, and
-- `<C-r>` is the mirror image (text redo first, glean actions after), so redo
-- replays the undos in the reverse of the order they were taken.
--
-- `seq` is the `undotree().seq_last` observed when the stacks were last
-- touched; it grows only when a novel state is created (undo/redo/`g-` move
-- `seq_cur` and leave it alone), which is what tells a fresh edit from a
-- time-travel apart. A novel edit wipes the stacks: a glean undo interleaved
-- with text the user has since rewritten would act on lines that no longer mean
-- what they did.
local api = vim.api

local M = {}

--- One reversible action. Both callbacks are re-entered long after the push, so
--- they must look their context up afresh rather than close over it. `cursor`
--- is the row the action touched: undo and redo park there, so what moved is
--- where the user is looking.
--- @alias GleanBufUndoAction { apply: fun(), reverse: fun(), cursor: integer? }

local stacks = {}
-- Buffers whose `u`/`<C-r>` maps and text-change autocmd are installed, each
-- holding the redraw callbacks its surfaces registered.
local active = {}

-- Whatever moved — a glean action or the buffer's own text undo — every surface
-- painting this buffer has to recompute, so notification is unconditional.
-- Park on the row the action touched, when the user is still in its buffer. A
-- glean action changes no text, so the row cannot have moved under us: a novel
-- edit would have wiped the stack the action was on.
local function goto_cursor(bufnr, row)
  if not row or api.nvim_get_current_buf() ~= bufnr then return end
  row = math.min(row, api.nvim_buf_line_count(bufnr))
  vim.cmd("normal! m'")
  api.nvim_win_set_cursor(0, { row, 0 })
end

local function notify(bufnr)
  for _, fn in ipairs(active[bufnr] or {}) do fn() end
end

local function stack(bufnr)
  local s = stacks[bufnr]
  if not s then
    s = { undo = {}, redo = {}, seq = vim.fn.undotree().seq_last }
    stacks[bufnr] = s
  end
  return s
end

function M.note_text_change(bufnr)
  local s = stacks[bufnr]
  if not s then return end
  local seq = vim.fn.undotree().seq_last
  if seq ~= s.seq then
    s.undo, s.redo, s.seq = {}, {}, seq
  end
end

--- Record an action that has already been applied.
--- @param action GleanBufUndoAction
function M.push(bufnr, action)
  M.note_text_change(bufnr)
  local s = stack(bufnr)
  s.undo[#s.undo + 1] = action
  s.redo = {}
end

-- Step the buffer's own undo tree, reporting whether anything moved.
local function text_step(cmd)
  local before = vim.fn.undotree().seq_cur
  pcall(vim.cmd, cmd)
  return vim.fn.undotree().seq_cur ~= before
end

--- Reverse the most recent glean action, or fall through to text undo.
--- Returns whether a glean action was the thing that moved.
function M.undo(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  M.note_text_change(bufnr)
  local a = table.remove(stack(bufnr).undo)
  if not a then
    text_step("undo")
    notify(bufnr)
    return false
  end
  a.reverse()
  goto_cursor(bufnr, a.cursor)
  local s = stack(bufnr)
  s.redo[#s.redo + 1] = a
  notify(bufnr)
  return true
end

--- Text redo first; a glean action comes back only once the buffer's own undo
--- tree has nothing left to replay.
function M.redo(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  M.note_text_change(bufnr)
  if text_step("redo") then
    notify(bufnr)
    return false
  end
  local a = table.remove(stack(bufnr).redo)
  if not a then return false end
  a.apply()
  goto_cursor(bufnr, a.cursor)
  local s = stack(bufnr)
  s.undo[#s.undo + 1] = a
  notify(bufnr)
  return true
end

--- Install the buffer-local wiring, once per buffer. `u`/`<C-r>` are static
--- from then on and fall through to the buffer's own undo when the glean stack
--- is empty; installing and removing them as the stack fills would race with
--- the very keypress that empties it.
--- `on_change` is called after every undo/redo through this layer.
function M.activate(bufnr, on_change)
  local listeners = active[bufnr]
  if listeners then
    listeners[#listeners + 1] = on_change
    return
  end
  active[bufnr] = { on_change }
  vim.keymap.set("n", "u", function() M.undo(bufnr) end,
    { buffer = bufnr, nowait = true, silent = true })
  vim.keymap.set("n", "<C-r>", function() M.redo(bufnr) end,
    { buffer = bufnr, nowait = true, silent = true })
  api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    buffer = bufnr,
    group = api.nvim_create_augroup("GleanBufUndo" .. bufnr, { clear = true }),
    callback = function() M.note_text_change(bufnr) end,
  })
end

return M
