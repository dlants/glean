-- Comment records: a selection of lines, annotated per entry, resolvable
-- against either a diff (all entries) or a plain file (non-deleted entries).
--
-- The projection/resolution half is pure. The bottom half is a process-wide
-- registry of comment stores keyed by state dir + worktree shard, so surfaces
-- with no review session (a file overlay) read and write the same on-disk shard
-- a session does.
local state = require("glean.state")

local M = {}

-- Every entry's text, in order — the sequence a diff view searches.
function M.diff_projection(record)
  local out = {}
  for _, e in ipairs(record.content or {}) do out[#out + 1] = e.text end
  return out
end

-- The post-image lines of the selection — the sequence a file view searches.
function M.file_projection(record)
  local out = {}
  for _, e in ipairs(record.content or {}) do
    if e.kind ~= "del" then out[#out + 1] = e.text end
  end
  return out
end

-- Resolve `record` against `lines` (a sequence of line texts). `lnum_of(i)`
-- maps an index in `lines` to a post-image line number (identity for a file
-- buffer). `projection` is "diff" (default) or "file".
-- Returns { index, lnum, outdated }: `index` is the match start in `lines` (nil
-- when outdated) and `lnum` the resolved line, or the fallback slot — the index
-- whose lnum is nearest the record's `lnum` — when nothing matches.
function M.locate(record, lines, lnum_of, projection)
  lnum_of = lnum_of or function(i) return i end
  local needles = projection == "file" and M.file_projection(record)
    or M.diff_projection(record)
  local anchor = record.lnum
  if #needles > 0 then
    local start = state.resolve(needles, lines, lnum_of, anchor)
    if start then
      return { index = start, lnum = lnum_of(start), outdated = false }
    end
  end
  local best, best_lnum, best_dist
  for i = 1, #lines do
    local l = lnum_of(i)
    if l then
      local dist = math.abs(l - (anchor or 0))
      if not best_dist or dist < best_dist then best, best_lnum, best_dist = i, l, dist end
    end
  end
  return { index = nil, lnum = best_lnum or anchor, fallback = best, outdated = true }
end

-- ── Repo context + store registry ───────────────────────────────────────────

local contexts, roots, stores = {}, {}, {}

-- Contexts are keyed by the fully resolved repo root, so a path reached through
-- a symlink (macOS `/var` → `/private/var`) finds the same registration.
local function canon(path) return vim.fs.normalize(vim.fn.resolve(path)) end

-- Seed the context for a repo root, bypassing discovery. A test/config seam:
-- everything else derives the same triple from `glean.repo_state_dir` /
-- `glean.wt_shard`.
function M.register(repo_root, dir, wt_shard)
  contexts[canon(repo_root)] = { repo_root = repo_root, dir = dir, wt_shard = wt_shard }
  return contexts[canon(repo_root)]
end

-- The { repo_root, dir, wt_shard } a buffer's comments live under, or nil when
-- the buffer is not a file inside a git repo. Memoized per directory (the
-- upward `.git` walk) and per repo root (the git calls behind the state dir), so
-- the gate on a hot autocmd is a table lookup.
function M.context(bufnr)
  local git = require("glean.git")
  local name = vim.api.nvim_buf_get_name(bufnr or 0)
  if name == "" or name:match("^%w%w+://") then return nil end
  local dirname = vim.fs.dirname(name)
  local root = roots[dirname]
  if root == nil then
    root = git.discover_repo_root(name) or false
    roots[dirname] = root
  end
  if not root then return nil end
  local ctx = contexts[canon(root)]
  if not ctx then
    local glean = require("glean")
    local handle = git.new({ repo_root = root })
    ctx = M.register(root, glean.repo_state_dir(handle), glean.wt_shard(handle))
  end
  return ctx
end

-- The Store for a context, with only the comment shard loaded.
function M.store(ctx)
  local key = ctx.dir .. "\0" .. ctx.wt_shard
  local store = stores[key]
  if not store then
    store = state.new({ dir = ctx.dir, wt_shard = ctx.wt_shard })
    store:load({})
    stores[key] = store
  end
  return store
end

-- Drop every memoized store for a state dir, so the next read comes off disk.
function M.invalidate(dir)
  for key in pairs(stores) do
    if key:sub(1, #dir + 1) == dir .. "\0" then stores[key] = nil end
  end
end

function M.for_path(ctx, path)
  return M.store(ctx):comments_for(path)
end

-- Apply one comment action against a context's store and persist it. `op`
-- overrides the action's own op, which is how a reverse is expressed (the
-- "un…" ops). Mirrors Session:apply_comment so a file buffer and the review
-- buffer share one mutation vocabulary.
function M.apply(ctx, a, op)
  local store = M.store(ctx)
  op = op or a.op or "add"
  if op == "add" then
    store:add_comment_record(a.path, a.record)
  elseif op == "remove" then
    store:remove_comment_record(a.path, a.record)
  elseif op == "edit" then
    store:remove_comment_record(a.path, a.old_record)
    store:add_comment_record(a.path, a.record)
  elseif op == "unedit" then
    store:remove_comment_record(a.path, a.record)
    store:add_comment_record(a.path, a.old_record)
  elseif op == "reply" then
    store:set_comment_reply(a.path, a.record, a.reply)
  elseif op == "unreply" then
    store:set_comment_reply(a.path, a.record, a.old_reply)
  end
  M.persist(ctx, a.path)
end

local REVERSE = { add = "remove", remove = "add", edit = "unedit", reply = "unreply" }

function M.reverse(ctx, a)
  M.apply(ctx, a, REVERSE[a.op or "add"])
end

-- Open an ephemeral, multi-line comment editor in a split above `win` (the
-- current window when nil), seeded with `initial` lines. `:w` or `<CR>`
-- (normal mode) submits the buffer text to `on_submit`; `q` or `<C-c>`
-- cancels. The scratch buffer is wiped on close so nothing persists outside
-- the review store.
function M.open_editor(win, initial, on_submit)
  local api = vim.api
  local ebuf = api.nvim_create_buf(false, true)
  api.nvim_set_option_value("buftype", "acwrite", { buf = ebuf })
  api.nvim_set_option_value("bufhidden", "wipe", { buf = ebuf })
  api.nvim_set_option_value("filetype", "markdown", { buf = ebuf })
  pcall(api.nvim_buf_set_name, ebuf, "glean-comment://" .. ebuf)
  local seed = (initial and #initial > 0) and initial or { "" }
  api.nvim_buf_set_lines(ebuf, 0, -1, false, seed)

  if win and api.nvim_win_is_valid(win) then api.nvim_set_current_win(win) end
  vim.cmd("aboveleft split")
  local ewin = api.nvim_get_current_win()
  api.nvim_win_set_buf(ewin, ebuf)
  api.nvim_win_set_height(ewin, math.max(5, math.min(15, #seed + 1)))

  local done = false
  local function finish(submit)
    if done then return end
    done = true
    local text
    if submit then
      text = table.concat(api.nvim_buf_get_lines(ebuf, 0, -1, false), "\n")
    end
    if api.nvim_win_is_valid(ewin) then pcall(api.nvim_win_close, ewin, true) end
    if submit and text and text:match("%S") then on_submit(text) end
  end

  api.nvim_create_autocmd("BufWriteCmd", { buffer = ebuf, callback = function() finish(true) end })
  vim.keymap.set("n", "<CR>", function() finish(true) end, { buffer = ebuf, nowait = true, silent = true })
  vim.keymap.set("n", "q", function() finish(false) end, { buffer = ebuf, nowait = true, silent = true })
  vim.keymap.set("n", "<C-c>", function() finish(false) end, { buffer = ebuf, silent = true })
  -- A new (empty) comment drops straight into insert; editing an existing one
  -- starts in normal mode so the seeded text can be navigated first.
  if initial and #initial > 0 then
    pcall(api.nvim_win_set_cursor, ewin, { #seed, 0 })
  else
    vim.cmd("startinsert")
  end
  return ebuf, ewin
end

-- Persist the comment shard and announce the change to the other surfaces.
function M.persist(ctx, path)
  M.store(ctx):save_commit(ctx.wt_shard)
  vim.api.nvim_exec_autocmds("User", {
    pattern = "GleanCommentsChanged",
    data = { dir = ctx.dir, path = path, source = "registry" },
  })
end

return M
