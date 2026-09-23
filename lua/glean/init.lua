-- glean entry point. All review logic runs in the node backend (node/); this
-- module only configures highlights and starts it.
local M = {}
M.config = {
  default_base = "main",
  ignore_whitespace = false,
  -- Seen runs shorter than this inside a partially-seen hunk render unseen.
  min_seen_run = 5,
  gutter = { enabled = true, suppress = "auto" },
  -- Columns the active hunk's body shifts right, after a short delay.
  hunk_indent = 2,
  hunk_indent_delay_ms = 50,
}
local function fg_only(src)
  local hl = vim.api.nvim_get_hl(0, { name = src, link = false })
  return { fg = hl.fg, bold = hl.bold, italic = hl.italic }
end
-- Re-applied on ColorScheme: GleanAddText/GleanDelText derive from the
-- resolved DiffAdd/DiffDelete colours rather than a static link.
local function setup_highlights()
  local links = {
    GleanFileHeader = "Title",
    GleanCommitHeader = "Title",
    GleanHunkHeader = "Comment",
    GleanAdd = "DiffAdd",
    GleanDel = "DiffDelete",
    GleanAddEmph = "DiffAdd",
    GleanDelEmph = "DiffDelete",
    GleanContext = "Normal",
    GleanSeen = "NonText",
    GleanComment = "WarningMsg",
    GleanCommentId = "Number",
    GleanCommentOutdated = "NonText",
    GleanCommentLine = "CursorLine",
    GleanCommentReply = "Comment",
    GleanModeHeader = "Title",
    GleanDivider = "Todo",
    GleanCurrentHunk = "Identifier",
  }
  for name, link in pairs(links) do
    vim.api.nvim_set_hl(0, name, { link = link, default = true })
  end
  vim.api.nvim_set_hl(0, "GleanAddText", fg_only("DiffAdd"))
  vim.api.nvim_set_hl(0, "GleanDelText", fg_only("DiffDelete"))
  require("glean.node_gutter").setup_highlights()
end
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  vim.g.glean_min_seen_run = M.config.min_seen_run
  vim.g.glean_ignore_whitespace = M.config.ignore_whitespace
  require("glean.node_gutter").setup(M.config.gutter)
  setup_highlights()
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("GleanHighlights", { clear = true }),
    callback = setup_highlights,
  })
  local node = require("glean.node")
  if not node.job_id then node.start() end
end
return M
