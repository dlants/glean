-- glean.gutter: the review's state projected into the gutter of the ordinary
-- file buffer.
--
-- The projection itself (`M.project`) is pure — a file's hunks plus a seen
-- predicate become a post-image `lnum -> mark` map — so it unit-tests headless
-- like glean.diff / glean.intraline. Rendering is the same discipline
-- glean.overlay follows for comments: never track positions, recompute the
-- whole map from the live model on every event that can move it and re-stamp.
local api = vim.api
local intraline = require("glean.intraline")
local git = require("glean.git")

local M = {}

--- @alias GleanGutterMark { kind: string?, del_below: boolean?, del_above: boolean?, seen: boolean }

-- Fold one more identity's seen-ness into a row's mark: a row that stands for
-- several diff lines (a change row, a row carrying deletions) reads as seen only
-- when every one of them is.
local function fold(marks, lnum, seen, fields)
  local m = marks[lnum]
  if not m then
    m = { seen = true }
    marks[lnum] = m
  end
  m.seen = m.seen and seen
  for k, v in pairs(fields) do
    m[k] = v
  end
  return m
end

-- Attach an unpaired deletion to the nearest *post-image* row: the row above the
-- slot it was removed from, or row 1 (as `del_above`) when it was removed from
-- the top of the file.
-- ...within a block that also has added lines the deletion belongs to the edited
-- region, so it ticks the block's last post-image row rather than the context
-- line above the block.
local function mark_deletion(marks, dl, seen)
  local above = (dl.new_lnum or 1) - 1
  if above >= 1 then
    fold(marks, above, seen, { del_below = true })
  else
    fold(marks, 1, seen, { del_above = true })
  end
end

-- Classify one del/add block. Coupling is `intraline.pair_lines`, the same
-- similarity pairing the review buffer uses for intra-line emphasis, so "this
-- looks like an edit" means the same thing in both places.
local function project_block(marks, dels, adds)
  local del_texts, add_texts = {}, {}
  for i, d in ipairs(dels) do
    del_texts[i] = d.dl.text
  end
  for i, a in ipairs(adds) do
    add_texts[i] = a.dl.text
  end
  local paired = intraline.pair_lines(del_texts, add_texts)
  local del_used = {}
  for _, p in ipairs(paired.pairs) do
    local d, a = dels[p[1]], adds[p[2]]
    del_used[p[1]] = true
    fold(marks, a.dl.new_lnum, a.seen and d.seen, { kind = "change" })
  end
  for _, ai in ipairs(paired.add_unpaired) do
    local a = adds[ai]
    fold(marks, a.dl.new_lnum, a.seen, { kind = "add" })
  end
  local anchor = #adds > 0 and adds[#adds].dl.new_lnum or nil
  for di = 1, #dels do
    if not del_used[di] then
      if anchor then
        fold(marks, anchor, dels[di].seen, { del_below = true })
      else
        mark_deletion(marks, dels[di].dl, dels[di].seen)
      end
    end
  end
end

--- Pure. `hunks` is a FileEntry's hunk list; `is_seen(dl, hunk, i)` answers
--- seen-ness for one diff line (`i` is its index within `hunk.lines`).
--- Returns `lnum -> GleanGutterMark` in post-image coordinates.
--- @return table<integer, GleanGutterMark>
function M.project(hunks, is_seen)
  local marks = {}
  for _, hunk in ipairs(hunks or {}) do
    local lines = hunk.lines or {}
    local i = 1
    while i <= #lines do
      local dl = lines[i]
      if dl.kind == "context" then
        i = i + 1
      else
        local dels, adds = {}, {}
        while i <= #lines and lines[i].kind ~= "context" do
          local cur = lines[i]
          local entry = { dl = cur, seen = is_seen(cur, hunk, i) and true or false }
          if cur.kind == "del" then
            dels[#dels + 1] = entry
          else
            adds[#adds + 1] = entry
          end
          i = i + 1
        end
        project_block(marks, dels, adds)
      end
    end
  end
  return marks
end

-- ── Rendering ───────────────────────────────────────────────────────────────

local ns = api.nvim_create_namespace("glean_gutter")
-- Buffers carrying gutter marks, so a teardown clears exactly what it painted.
local painted = {}

-- Shape carries the kind, colour carries the seen status: a marked line keeps
-- its glyph in place but greys out, so unreviewed work is what draws the eye.
local GLYPH = { add = "▎", change = "▎", del = "▁" }
local GROUP = { add = "GleanGutterAdd", change = "GleanGutterChange", del = "GleanGutterDelete" }

function M.setup_highlights()
  local links = {
    GleanGutterAdd = "DiffAdd",
    GleanGutterChange = "DiffChange",
    GleanGutterDelete = "DiffDelete",
    GleanGutterAddSeen = "Comment",
    GleanGutterChangeSeen = "Comment",
    GleanGutterDeleteSeen = "Comment",
  }
  for name, link in pairs(links) do
    api.nvim_set_hl(0, name, { link = link, default = true })
  end
end

local function stamp(bufnr, lnum, mark)
  local kind = mark.kind or "del"
  api.nvim_buf_set_extmark(bufnr, ns, lnum - 1, 0, {
    sign_text = GLYPH[kind],
    sign_hl_group = GROUP[kind] .. (mark.seen and "Seen" or ""),
  })
end

-- The live work-tree session and this buffer's repo-relative path, or nil when
-- there is nothing the gutter can prove: no session, a commit-targeted one
-- (whose post-image is a snapshot the buffer may have moved past), a buffer
-- outside the session's repo, or a buffer edited since the last model refresh.
local function buf_target(bufnr, allow_modified)
  if M.config and M.config.enabled == false then return nil end
  local session = require("glean.init").current_session()
  if not (session and session.worktree) then return nil end
  if vim.bo[bufnr].modified and not allow_modified then return nil end
  local name = api.nvim_buf_get_name(bufnr)
  if name == "" then return nil end
  local path = git.relpath(session.git.repo_root, name)
  if not path then return nil end
  return session, path
end

local function clear(bufnr)
  if painted[bufnr] then painted[bufnr] = nil end
  if api.nvim_buf_is_valid(bufnr) then api.nvim_buf_clear_namespace(bufnr, ns, 0, -1) end
end

-- ── Foreign sign provider suppression ───────────────────────────────────────
--
-- Another plugin (gitsigns by default) already paints diff signs in the same
-- column; while a review is live the glean projection replaces it. Buffers we
-- detached are recorded so teardown reattaches exactly those, and every call
-- into the foreign plugin is pcall'd: a missing or renamed provider must never
-- break the gutter.
local suppressed = {}

local AUTO = {
  detach = function(bufnr) require("gitsigns").detach(bufnr) end,
  attach = function(bufnr) require("gitsigns").attach(bufnr) end,
}

local function provider()
  local s = M.config and M.config.suppress
  if s == nil or s == "auto" then return AUTO end
  if type(s) == "table" then return s end
  return nil
end

local function suppress(bufnr)
  if suppressed[bufnr] then return end
  local p = provider()
  if not (p and p.detach) then return end
  suppressed[bufnr] = true
  pcall(p.detach, bufnr)
end

local function restore(bufnr)
  if not suppressed[bufnr] then return end
  suppressed[bufnr] = nil
  local p = provider()
  if p and p.attach and api.nvim_buf_is_valid(bufnr) then pcall(p.attach, bufnr) end
end

--- Recompute and re-stamp `bufnr`. No-op (beyond clearing) when there is no
--- live work-tree session, the buffer is not one of its files, or the buffer
--- has diverged from the model.
function M.refresh(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  if not api.nvim_buf_is_loaded(bufnr) then return end
  -- Suppression follows membership in the review, not paintedness: a buffer
  -- momentarily modified (and so cleared) is still the review's file, and
  -- handing the column back to the other plugin for one keystroke would flicker.
  local member, mpath = buf_target(bufnr, true)
  if member and member:file_status(mpath) then suppress(bufnr) else restore(bufnr) end
  local session, path = buf_target(bufnr)
  local marks = session and session:file_status(path) or nil
  clear(bufnr)
  if not marks or next(marks) == nil then return end
  painted[bufnr] = true
  local total = api.nvim_buf_line_count(bufnr)
  for lnum, mark in pairs(marks) do
    if lnum >= 1 and lnum <= total then stamp(bufnr, lnum, mark) end
  end
end

--- Clear the marks from every buffer we painted and hand the sign column back
--- to the foreign provider on every buffer we took it from.
function M.clear_all()
  for bufnr in pairs(painted) do clear(bufnr) end
  painted = {}
  for bufnr in pairs(suppressed) do restore(bufnr) end
  suppressed = {}
end

-- Every loaded, named buffer that could belong to a review: the painted ones
-- (which may need clearing) plus the rest (which may need a first paint).
local function refresh_all()
  for _, bufnr in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(bufnr) and api.nvim_buf_get_name(bufnr) ~= "" then
      M.refresh(bufnr)
    end
  end
end

function M.setup(cfg)
  M.config = vim.tbl_extend("force", { enabled = true, suppress = "auto" }, cfg or {})
  M.setup_highlights()
  local group = api.nvim_create_augroup("GleanGutter", { clear = true })
  api.nvim_create_autocmd({ "BufReadPost", "BufWinEnter", "BufWritePost", "FileChangedShellPost" }, {
    group = group,
    callback = function(args) M.refresh(args.buf) end,
  })
  -- An edited buffer has diverged from the model until the next poll, and a
  -- marker on the wrong row is worse than no marker.
  api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = function(args)
      if painted[args.buf] then clear(args.buf) end
    end,
  })
  api.nvim_create_autocmd("User", {
    group = group,
    pattern = "GleanReviewChanged",
    callback = function() refresh_all() end,
  })
  api.nvim_create_autocmd("VimLeavePre", { group = group, callback = function() M.clear_all() end })
end

return M
