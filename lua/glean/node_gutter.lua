-- Lua half of the file-buffer gutter. Node owns the projection, painting,
-- marking and the mark undo stacks; this module only forwards events and
-- keys (each O(1) plus one rpcnotify), answers buffer queries, and hosts the
-- foreign sign provider (gitsigns) detach/reattach, which has to run here.
local api = vim.api
local M = {}

M.config = { suppress = "auto", keymaps = true, toggle_key = "gt", focus = true }

local function notify(ev)
  local node = require("glean.node")
  return node.safe_rpcnotify(node.channel_id, "gleanGutter", ev)
end

-- ── Foreign sign provider suppression ──────────────────────────────────────
-- Detaching a buffer gitsigns is not attached to trips an assert inside it
-- later; `get_hunks` returning nil is its "not attached" answer.
local AUTO = {
  detach = function(bufnr)
    local gs = require("gitsigns")
    if gs.get_hunks(bufnr) ~= nil then gs.detach(bufnr) end
  end,
  attach = function(bufnr) require("gitsigns").attach(bufnr) end,
}
local function provider()
  local s = M.config.suppress
  if s == nil or s == "auto" then return AUTO end
  if type(s) == "table" then return s end
  return nil
end
local suppressed = {}

-- ── Keymaps ─────────────────────────────────────────────────────────────────
local function row() return api.nvim_win_get_cursor(0)[1] end

function M.op()
  notify({ kind = "toggle-mark", buf = api.nvim_get_current_buf(),
    line1 = vim.fn.line("'["), line2 = vim.fn.line("']") })
end

-- `u`/`<C-r>` spend the node-held mark stack only when it is non-empty and no
-- novel edit happened since (`seq_last` moved); otherwise they are plain text
-- undo/redo. The stack depth is mirrored into `b:glean_undo` by node.
local function stack_live(buf, field)
  local st = vim.b[buf].glean_undo
  return st and st.seq == vim.fn.undotree().seq_last and (st[field] or 0) > 0
end
function M.undo(buf)
  if stack_live(buf, "undo") then
    notify({ kind = "undo", buf = buf, seq = vim.fn.undotree().seq_last })
  else
    pcall(vim.cmd, "undo")
  end
end
function M.redo(buf)
  local before = vim.fn.undotree().seq_cur
  pcall(vim.cmd, "redo")
  if vim.fn.undotree().seq_cur ~= before then return end
  if stack_live(buf, "redo") then
    notify({ kind = "redo", buf = buf, seq = vim.fn.undotree().seq_last })
  end
end

local function maps(buf)
  return {
    { "n", "]c", function() notify({ kind = "goto-hunk", buf = buf, row = row(), dir = 1 }) end, "glean: next hunk" },
    { "n", "[c", function() notify({ kind = "goto-hunk", buf = buf, row = row(), dir = -1 }) end, "glean: previous hunk" },
    { "n", "gm", "<Cmd>set operatorfunc=v:lua.require'glean.node_gutter'.op<CR>g@", "glean: toggle mark over a motion" },
    { "n", "gmm", "<Cmd>set operatorfunc=v:lua.require'glean.node_gutter'.op<CR>g@_", "glean: toggle mark on this line" },
    { "n", "gmc", function() notify({ kind = "toggle-mark", buf = buf, line1 = row() }) end, "glean: toggle mark on this hunk" },
    { "x", "gm", function()
      local a, b = vim.fn.line("v"), vim.fn.line(".")
      api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
      notify({ kind = "toggle-mark", buf = buf, line1 = math.min(a, b), line2 = math.max(a, b) })
    end, "glean: toggle mark on selection" },
    { "n", "u", function() M.undo(buf) end, "glean: undo mark, then text" },
    { "n", "<C-r>", function() M.redo(buf) end, "glean: redo text, then mark" },
  }
end
local mapped = {}

--- Called by node when `buf` joins the review: take the sign column from the
--- foreign provider (re-asserted every time, since it re-attaches itself) and
--- install the maps once.
function M.attach(buf)
  if not api.nvim_buf_is_valid(buf) then return end
  local p = provider()
  if p and p.detach then
    suppressed[buf] = true
    pcall(p.detach, buf)
  end
  if mapped[buf] or M.config.keymaps == false then return end
  mapped[buf] = true
  for _, m in ipairs(maps(buf)) do
    vim.keymap.set(m[1], m[2], m[3], { buffer = buf, silent = true, nowait = true, desc = m[4] })
  end
end

--- Called by node when `buf` leaves the review (or on teardown).
function M.detach(buf)
  if suppressed[buf] then
    suppressed[buf] = nil
    local p = provider()
    if p and p.attach and api.nvim_buf_is_valid(buf) then pcall(p.attach, buf) end
  end
  if not mapped[buf] then return end
  mapped[buf] = nil
  if not api.nvim_buf_is_valid(buf) then return end
  for _, m in ipairs(maps(buf)) do pcall(vim.keymap.del, m[1], m[2], { buffer = buf }) end
end

--- Node's one query per event: the facts it needs about each buffer. With
--- `bufs` nil, every loaded named buffer. `seq_last` (which builds the whole
--- undo tree) is only computed when `with_seq` is set.
function M.info(bufs, with_seq)
  if bufs == nil or bufs == vim.NIL then
    bufs = {}
    for _, b in ipairs(api.nvim_list_bufs()) do
      if api.nvim_buf_is_loaded(b) and api.nvim_buf_get_name(b) ~= "" then bufs[#bufs + 1] = b end
    end
  end
  local win = api.nvim_get_current_win()
  local out = {}
  for _, b in ipairs(bufs) do
    if api.nvim_buf_is_loaded(b) then
      local cursor = vim.NIL
      if api.nvim_win_get_buf(win) == b then cursor = api.nvim_win_get_cursor(win)[1] end
      out[#out + 1] = {
        buf = b,
        name = api.nvim_buf_get_name(b),
        modified = vim.bo[b].modified,
        lines = api.nvim_buf_line_count(b),
        cursor = cursor,
        seq = with_seq and api.nvim_buf_call(b, function() return vim.fn.undotree().seq_last end) or vim.NIL,
        focus = M.config.focus ~= false,
      }
    end
  end
  return out
end

function M.setup_highlights()
  local links = {
    GleanGutterAdd = "DiffAdd", GleanGutterChange = "DiffChange", GleanGutterDelete = "DiffDelete",
    GleanGutterAddSeen = "Comment", GleanGutterChangeSeen = "Comment", GleanGutterDeleteSeen = "Comment",
    GleanGutterContext = "NonText", GleanGutterContextSeen = "NonText", GleanGutterStale = "NonText",
  }
  for name, link in pairs(links) do api.nvim_set_hl(0, name, { link = link, default = true }) end
end

--- Merge `cfg` into the gutter config (suppress may be a `{detach, attach}`
--- table, so it can only live on this side).
function M.setup(cfg)
  M.config = vim.tbl_extend("force", M.config, cfg or {})
end

--- Installed by the bridge.
function M.bridge(group)
  M.setup_highlights()
  local function refresh(args) notify({ kind = "refresh", buf = args.buf }) end
  api.nvim_create_autocmd({ "BufReadPost", "BufWinEnter", "BufWritePost", "FileChangedShellPost" },
    { group = group, callback = refresh })
  -- A deferred change event on a background buffer an external writer left
  -- matching disk must not wipe a valid gutter.
  api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = function(args) if vim.bo[args.buf].modified then refresh(args) end end,
  })
  api.nvim_create_autocmd({ "CursorMoved", "WinEnter" }, {
    group = group,
    callback = function(args)
      if mapped[args.buf] or suppressed[args.buf] then
        notify({ kind = "focus", buf = args.buf, row = row() })
      end
    end,
  })
  api.nvim_create_autocmd("BufWipeout", {
    group = group,
    callback = function(args)
      mapped[args.buf], suppressed[args.buf] = nil, nil
      if vim.g.glean_node_channel then notify({ kind = "wipe", buf = args.buf }) end
    end,
  })
  if M.config.toggle_key then
    vim.keymap.set("n", M.config.toggle_key, function()
      notify({ kind = "toggle", buf = api.nvim_get_current_buf() })
    end, { silent = true, desc = "glean: toggle the gutter for this buffer" })
  end
end

--- Bridge teardown: give every buffer back.
function M.teardown()
  for buf in pairs(vim.tbl_extend("force", {}, mapped, suppressed)) do M.detach(buf) end
  local ns = { api.nvim_create_namespace("glean_gutter"), api.nvim_create_namespace("glean_gutter_focus") }
  for _, b in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_valid(b) then
      for _, n in ipairs(ns) do api.nvim_buf_clear_namespace(b, n, 0, -1) end
    end
  end
end

return M
