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

--- A row's `sources` are the coordinates, within the file's hunk list, of every
--- diff line folded into it: `hunk` indexes `hunks`, `li` indexes
--- `hunks[hunk].lines`. Both are indices, never line numbers.
--- @alias GleanGutterSource { hunk: integer, li: integer }
--- @alias GleanGutterMark { kind: string?, del_below: boolean?, del_above: boolean?, seen: boolean, sources: GleanGutterSource[] }

-- Fold one more identity's seen-ness into a row's mark: a row that stands for
-- several diff lines (a change row, a row carrying deletions) reads as seen only
-- when every one of them is.
local function fold(marks, lnum, entries, fields)
  local m = marks[lnum]
  if not m then
    m = { seen = true, sources = {} }
    marks[lnum] = m
  end
  for _, e in ipairs(entries) do
    m.seen = m.seen and e.seen
    m.sources[#m.sources + 1] = e.src
  end
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
local function mark_deletion(marks, entry)
  local above = (entry.dl.new_lnum or 1) - 1
  if above >= 1 then
    fold(marks, above, { entry }, { del_below = true })
  else
    fold(marks, 1, { entry }, { del_above = true })
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
    fold(marks, a.dl.new_lnum, { a, d }, { kind = "change" })
  end
  for _, ai in ipairs(paired.add_unpaired) do
    local a = adds[ai]
    fold(marks, a.dl.new_lnum, { a }, { kind = "add" })
  end
  local anchor = #adds > 0 and adds[#adds].dl.new_lnum or nil
  for di = 1, #dels do
    if not del_used[di] then
      if anchor then
        fold(marks, anchor, { dels[di] }, { del_below = true })
      else
        mark_deletion(marks, dels[di])
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
  for hi, hunk in ipairs(hunks or {}) do
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
          local entry =
          { dl = cur, seen = is_seen(cur, hunk, i) and true or false, src = { hunk = hi, li = i } }
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
    -- A hunk reads as one region, so context lines *between* its first and last
    -- change get a marker too — a thinner, dimmer one, carrying no sources: it
    -- is never a `]c` stop, never something `gm` can mark, purely connective
    -- tissue so a hunk stops rendering as a scatter of disconnected rows. The
    -- leading/trailing context stays bare: the hunk should end where its last
    -- change is.
    local lo, hi
    for li, dl in ipairs(lines) do
      if dl.kind ~= "context" then
        lo = lo or li
        hi = li
      end
    end
    for li = (lo or 1), (hi or 0) do
      local dl = lines[li]
      if dl.kind == "context" and dl.new_lnum and not marks[dl.new_lnum] then
        marks[dl.new_lnum] = { kind = "context", seen = true, sources = {} }
      end
    end
  end
  return marks
end

--- Pure. The first post-image row of each hunk present in `marks`, ascending.
--- A row folds several diff lines, so it starts a hunk when it is the lowest
--- row any of that hunk's lines were folded into.
--- With `unseen_only`, hunks every row of which is already marked are dropped:
--- `]c` is a "take me to the next thing to review" motion, so a fully reviewed
--- hunk is not a stop. Falls back to every hunk when none is left unmarked, so
--- the motion still navigates a finished file.
--- @return integer[]
function M.hunk_starts(marks, unseen_only)
  local first, unseen = {}, {}
  for lnum, m in pairs(marks or {}) do
    for _, s in ipairs(m.sources or {}) do
      if not first[s.hunk] or lnum < first[s.hunk] then first[s.hunk] = lnum end
      if not m.seen then unseen[s.hunk] = true end
    end
  end
  local function collect(filter)
    local at, rows = {}, {}
    for hunk, lnum in pairs(first) do
      if (not filter or unseen[hunk]) and not at[lnum] then
        at[lnum] = true
        rows[#rows + 1] = lnum
      end
    end
    table.sort(rows)
    return rows
  end
  local rows = collect(unseen_only)
  if unseen_only and #rows == 0 then rows = collect(false) end
  return rows
end

--- Pure. The inclusive post-image row range `gmc` (no-range `:Glean toggle-mark`)
--- would act on from `cur`: every row any line of the hunks owning `cur` was
--- folded into. nil when `cur` carries no diff line.
--- @return integer?, integer?
function M.hunk_range(marks, cur)
  local m = marks and marks[cur]
  if not m then return nil end
  local want = {}
  for _, s in ipairs(m.sources or {}) do want[s.hunk] = true end
  local lo, hi
  for lnum, other in pairs(marks) do
    for _, s in ipairs(other.sources or {}) do
      if want[s.hunk] then
        if not lo or lnum < lo then lo = lnum end
        if not hi or lnum > hi then hi = lnum end
        break
      end
    end
  end
  return lo, hi
end

--- Pure. The row `]c` / `[c` land on from `cur`, wrapping around the file.
--- nil when there is nothing to move to.
function M.next_hunk_row(rows, cur, dir)
  if #rows == 0 then return nil end
  if dir > 0 then
    for _, r in ipairs(rows) do
      if r > cur then return r end
    end
    return rows[1]
  end
  for i = #rows, 1, -1 do
    if rows[i] < cur then return rows[i] end
  end
  return rows[#rows]
end

-- ── Rendering ───────────────────────────────────────────────────────────────

local ns = api.nvim_create_namespace("glean_gutter")
-- Buffers carrying gutter marks, so a teardown clears exactly what it painted.
local painted = {}

-- Shape carries the kind, colour carries the seen status: a marked line keeps
-- its glyph in place but greys out, so unreviewed work is what draws the eye.
local GLYPH = { add = "▎", change = "▎", del = "▁", context = "▏" }
local GROUP = {
  add = "GleanGutterAdd",
  change = "GleanGutterChange",
  del = "GleanGutterDelete",
  context = "GleanGutterContext",
}
-- The hunk under the cursor — what `gmc` would act on — is drawn with a heavier
-- glyph in the same colour, so the target of the keystroke is legible without a
-- second colour scheme to learn.
local FOCUS_GLYPH = { add = "█", change = "█", del = "▄", context = "▎" }

function M.setup_highlights()
  local links = {
    GleanGutterAdd = "DiffAdd",
    GleanGutterChange = "DiffChange",
    GleanGutterDelete = "DiffDelete",
    GleanGutterAddSeen = "Comment",
    GleanGutterChangeSeen = "Comment",
    GleanGutterDeleteSeen = "Comment",
    GleanGutterContext = "NonText",
    GleanGutterContextSeen = "NonText",
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
-- Per-buffer opt-out, flipped by `M.toggle`. A buffer turned off is treated as
-- if it were not part of the review at all, so the sign column (and the foreign
-- provider it was taken from) goes back to how it was before glean touched it.
local off = {}
local function buf_target(bufnr, allow_modified)
  if M.config and M.config.enabled == false then return nil end
  if off[bufnr] then return nil end
  local session = require("glean.init").current_session()
  if not (session and session.worktree) then return nil end
  if vim.bo[bufnr].modified and not allow_modified then return nil end
  local name = api.nvim_buf_get_name(bufnr)
  if name == "" then return nil end
  local path = git.relpath(session.git.repo_root, name)
  if not path then return nil end
  return session, path
end
-- Focus marks live in their own namespace: they are recomputed on every cursor
-- move, far more often than the projection itself.
local ns_focus = api.nvim_create_namespace("glean_gutter_focus")

--- Re-stamp the "this is what `gmc` acts on" overlay for `bufnr`.
function M.refresh_focus(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  if not api.nvim_buf_is_valid(bufnr) then return end
  api.nvim_buf_clear_namespace(bufnr, ns_focus, 0, -1)
  if not painted[bufnr] then return end
  if M.config and M.config.focus == false then return end
  local win = api.nvim_get_current_win()
  if api.nvim_win_get_buf(win) ~= bufnr then return end
  local session, path = buf_target(bufnr)
  local marks = session and session:file_status(path) or nil
  if not marks then return end
  local lo, hi = M.hunk_range(marks, api.nvim_win_get_cursor(win)[1])
  if not lo then return end
  for lnum = lo, hi do
    local m = marks[lnum]
    if m then
      local kind = m.kind or "del"
      api.nvim_buf_set_extmark(bufnr, ns_focus, lnum - 1, 0, {
        sign_text = FOCUS_GLYPH[kind],
        sign_hl_group = GROUP[kind] .. (m.seen and "Seen" or ""),
        -- Above the base stamp's default (4096): with a single-width sign
        -- column only the top sign on a row is drawn, and the focus glyph is
        -- the one that has to win there.
        priority = 4097,
      })
    end
  end
end


-- ── Buffer-local keymaps ────────────────────────────────────────────────────
--
--- `operatorfunc` for the `gm` operator: mark the lines the motion covered.
--- Only the line range matters — marking is line-granular either way — so
--- charwise and blockwise motions are treated as the lines they touch.
function M.op()
  require("glean.init").toggle_mark(vim.fn.line("'["), vim.fn.line("']"))
end

-- The maps ride on *membership* in the review, not on paintedness: a buffer
-- momentarily modified is still the review's file, and `gm` there refuses with
-- a message rather than silently doing nothing because its map vanished.
local mapped = {}
local MAPS = {
  { "n", "]c",  function() M.goto_hunk(1) end,                                 "glean: next hunk" },
  { "n", "[c",  function() M.goto_hunk(-1) end,                                "glean: previous hunk" },
  { "n", "gj",  "<Cmd>Glean jump<CR>",                                         "glean: jump to the review" },
  { "n", "gm",  "<Cmd>set operatorfunc=v:lua.require'glean.gutter'.op<CR>g@",  "glean: toggle mark over a motion" },
  { "n", "gmm", "<Cmd>set operatorfunc=v:lua.require'glean.gutter'.op<CR>g@_", "glean: toggle mark on this line" },
  { "n", "gmc", "<Cmd>Glean toggle-mark<CR>",                                  "glean: toggle mark on this hunk" },
  { "x", "gm",  ":Glean toggle-mark<CR>",                                      "glean: toggle mark on selection" },
}

local function set_maps(bufnr)
  if mapped[bufnr] or not (M.config and M.config.keymaps ~= false) then return end
  mapped[bufnr] = true
  for _, m in ipairs(MAPS) do
    vim.keymap.set(m[1], m[2], m[3], { buffer = bufnr, silent = true, desc = m[4] })
  end
end

local function unset_maps(bufnr)
  if not mapped[bufnr] then return end
  mapped[bufnr] = nil
  if not api.nvim_buf_is_valid(bufnr) then return end
  for _, m in ipairs(MAPS) do
    pcall(vim.keymap.del, m[1], m[2], { buffer = bufnr })
  end
end

--- Move the cursor to the first row of the next (`dir > 0`) or previous hunk,
--- wrapping at the ends of the file.
function M.goto_hunk(dir)
  local bufnr = api.nvim_get_current_buf()
  local session, path = buf_target(bufnr)
  local marks = session and session:file_status(path) or nil
  if not marks then return end
  local row = M.next_hunk_row(M.hunk_starts(marks, true), api.nvim_win_get_cursor(0)[1], dir)
  if not row or row > api.nvim_buf_line_count(bufnr) then return end
  vim.cmd("normal! m'")
  api.nvim_win_set_cursor(0, { row, 0 })
end

local function clear(bufnr)
  if painted[bufnr] then painted[bufnr] = nil end
  if api.nvim_buf_is_valid(bufnr) then
    api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
    api.nvim_buf_clear_namespace(bufnr, ns_focus, 0, -1)
  end
end

-- ── Foreign sign provider suppression ───────────────────────────────────────
--
-- Another plugin (gitsigns by default) already paints diff signs in the same
-- column; while a review is live the glean projection replaces it. Buffers we
-- detached are recorded so teardown reattaches exactly those, and every call
-- into the foreign plugin is pcall'd: a missing or renamed provider must never
-- break the gutter.
local suppressed = {}

-- Detaching a buffer gitsigns is not attached to is not a no-op there: it drops
-- its cache entry while its buffer-attach handler lives on, and the next reload
-- of that buffer trips an assert inside gitsigns. `get_hunks` returning nil is
-- its "not attached" answer, so ask before detaching.
local AUTO = {
  detach = function(bufnr)
    local gs = require("gitsigns")
    if gs.get_hunks(bufnr) ~= nil then gs.detach(bufnr) end
  end,
  attach = function(bufnr) require("gitsigns").attach(bufnr) end,
}

local function provider()
  local s = M.config and M.config.suppress
  if s == nil or s == "auto" then return AUTO end
  if type(s) == "table" then return s end
  return nil
end

-- Detach on every refresh, not just the first: the foreign plugin re-attaches
-- itself on its own events (reload, write, explicit attach), so a latch here
-- would leave its signs interleaved with ours for the rest of the session. The
-- flag only records that a restore is owed.
local function suppress(bufnr)
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
  if member and member:file_status(mpath) then
    suppress(bufnr)
    set_maps(bufnr)
  else
    restore(bufnr)
    unset_maps(bufnr)
  end
  local session, path = buf_target(bufnr)
  local marks = session and session:file_status(path) or nil
  clear(bufnr)
  if not marks or next(marks) == nil then return end
  painted[bufnr] = true
  local total = api.nvim_buf_line_count(bufnr)
  for lnum, mark in pairs(marks) do
    if lnum >= 1 and lnum <= total then stamp(bufnr, lnum, mark) end
  end
  M.refresh_focus(bufnr)
end

--- Toggle the glean projection for one buffer. Turning it on when there is no
--- live work-tree review opens the default (`:Glean`) one in the background, so
--- the gutter can start a review rather than only shadow one. Returns the new
--- state.
function M.toggle(bufnr)
  bufnr = bufnr or api.nvim_get_current_buf()
  if not off[bufnr] and buf_target(bufnr, true) then
    off[bufnr] = true
    M.refresh(bufnr)
    return false
  end
  off[bufnr] = nil
  local init = require("glean.init")
  if not init.current_session() then
    local ok, err = pcall(init.open_dirty, { open_window = false })
    if not ok then
      vim.notify(tostring(err):match("(glean: .*)") or tostring(err), vim.log.levels.WARN)
      return false
    end
  end
  M.refresh(bufnr)
  return true
end

--- Clear the marks from every buffer we painted and hand the sign column back
--- to the foreign provider on every buffer we took it from.
function M.clear_all()
  for bufnr in pairs(painted) do clear(bufnr) end
  painted = {}
  for bufnr in pairs(suppressed) do restore(bufnr) end
  suppressed = {}
  for bufnr in pairs(mapped) do unset_maps(bufnr) end
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

--- Turn the gutter on or off for every buffer at once (`:Glean toggle-gutter`).
--- `config.enabled` is only the starting value of this switch. Enabling also
--- drops the per-buffer opt-outs, so a global "on" means on everywhere rather
--- than on-except-wherever-`gt`-was-pressed. Returns the new state.
function M.set_enabled(on)
  M.config = M.config or {}
  M.config.enabled = on and true or false
  if on then off = {} end
  refresh_all()
  return M.config.enabled
end

function M.toggle_all()
  return M.set_enabled(not (M.config and M.config.enabled ~= false))
end

function M.setup(cfg)
  M.config =
      vim.tbl_extend("force",
        { enabled = true, suppress = "auto", keymaps = true, toggle_key = "gt", focus = true },
        cfg or {})
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
  -- The focused hunk follows the cursor, so it is recomputed on every move
  -- rather than only when the projection changes.
  api.nvim_create_autocmd({ "CursorMoved", "WinEnter" }, {
    group = group,
    callback = function(args) M.refresh_focus(args.buf) end,
  })
  api.nvim_create_autocmd({ "BufWipeout" }, {
    group = group,
    callback = function(args) off[args.buf] = nil end,
  })
  if M.config.toggle_key then
    vim.keymap.set("n", M.config.toggle_key, function() M.toggle() end,
      { silent = true, desc = "glean: toggle the gutter for this buffer" })
  end
  api.nvim_create_autocmd("VimLeavePre", { group = group, callback = function() M.clear_all() end })
end

return M
