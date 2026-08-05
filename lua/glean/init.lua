-- glean: review the diff between two git refs in a single foldable buffer.
--
-- The model (FileEntries / Commits from glean.git, overlaid with the persisted
-- ReviewStore from glean.state) is the single source of truth; the buffer is a
-- pure projection of it. A parallel `row_map[row]` resolves any cursor row back
-- to its commit/file/hunk/line so actions can act on the semantic target.
--
-- Two scopes share one review store:
--   - "combined": the net diff base...target.
--   - "commits": every commit laid out flat, the natural place seen marks and
--     comments are *authored* against a stable (commit_sha, path, new_lnum).
--
-- Seen-ness has a single representation: a flat set of stable line-identities in
-- glean.state (committed add `(sha,lnum)`, committed del `(remover_sha,lnum)`,
-- and content-hashed worktree lines). The renderer's section placement, the
-- file/commit header glyphs, and the action layer all derive from the same
-- `Session:changed_lines`/`line_identity`/`line_seen`/`hunk_seen` resolver, so
-- "renders in the seen section" and "the action layer thinks it is seen" are
-- one computation by construction. Hunks are a pure display concern.
--
-- Collapse is ephemeral session view-state: it is initialized from seen status
-- when a scope is (re)built, then evolves independently and is never persisted.
--
-- Keymaps of note (`setup_keymaps`):
--   - normal `m` is overloaded: on a marker row/line (a collapsed seen sub-range
--     inside an unseen hunk, or any line of an expanded one) it unmarks that run;
--     on any other target it toggles the whole hunk/file/commit seen.
--   - visual `m` marks the selected lines seen; a partial selection renders as a
--     collapsed `✓ marked N lines` marker row (overlapping marks coalesce).
--   - visual `d` deletes all selected comments in the bottom summary.
--   - `=` toggles collapse, including expanding/collapsing a marker row.
local git_mod = require("glean.git")
local diff_mod = require("glean.diff")
local state_mod = require("glean.state")
local lineage = require("glean.lineage")
local intraline = require("glean.intraline")
local M = {}
local api = vim.api

-- Reserved non-sha id for the synthetic "floating" commit that stands in for the
-- working tree on top of HEAD. Its reviewed units are content-addressed (hashes)
-- rather than line ranges, since uncommitted lines have no stable line numbers.
M.WORKTREE = "WORKTREE"
local NS = api.nvim_create_namespace("glean_hl")
local NS_INTRA = api.nvim_create_namespace("glean_intra_hl")
local NS_CURSOR = api.nvim_create_namespace("glean_cursor_hl")
local NS_CURSOR_INDENT = api.nvim_create_namespace("glean_cursor_indent")
local NS_STICKY = api.nvim_create_namespace("glean_sticky_hl")


M.config = {
  default_base = "main",
  ignore_whitespace = false,
  -- Combined-scope display-only demotion threshold: a seen run inside a
  -- partially-seen hunk shorter than this collapses back to unseen rows rather
  -- than a `✓ marked` marker. 0 or 1 disables demotion entirely.
  min_seen_run = 5,
  -- Display indentation applied to the active hunk body (the header stays put).
  hunk_indent = 2,
  hunk_indent_delay_ms = 50,
}

-- Registry of live glean buffers, keyed by (repo_root, base, target), so a
-- second open of the same diff reuses its persistent, listed buffer instead of
-- spawning a duplicate. Lets you jump to a source file and come back via the
-- buffer list / `<C-^>`.
local buffers = {}

-- Live session per buffer key, so a reopen/refresh can stop the previous one's
-- update timer; and content-addressed collapse overrides per buffer key, kept in
-- process memory so a reload-from-disk never loses expand/collapse state.
local sessions = {}
local views = {}
local log_buffers = {}
local log_views = {}
local pr_buffers = {}
local pr_views = {}

-- How often the live work-tree review polls the repo for changes (ms).
-- Safety-net interval for the live work-tree review (ms). Refreshes are driven
-- by editor events; the timer only catches changes made outside the editor.
local LIVE_INTERVAL_MS = 5000

local function buffer_key(repo_root, base, target)
  return table.concat({ repo_root, base, target }, "\0")
end

-- Resolve the repo root from the buffer Glean was opened over, falling back to
-- cwd — mirroring the shuck/needle search-root discovery. Prefers cwd when the
-- origin buffer lives under it, else the nearest `.git` above the buffer, else
-- cwd itself.
local function resolve_repo_root(buf_name)
  local cwd = vim.fn.getcwd()
  local buf_dir
  if not buf_name or buf_name == "" or buf_name:match("^%w+://") then
    buf_dir = cwd
  else
    buf_dir = vim.fs.dirname(buf_name)
  end
  if buf_dir == cwd or buf_dir:sub(1, #cwd + 1) == cwd .. "/" then
    local at_cwd = git_mod.discover_repo_root(cwd)
    if at_cwd then return at_cwd end
  end
  return git_mod.discover_repo_root(buf_dir) or cwd
end

-- The persisted review-store directory for `git`'s repository. Anchored on the
-- git common dir (`Git:common_dir`), so every linked worktree of one repo shares
-- a single store while distinct repos diverge. The common dir is reduced to a
-- stable, filesystem-safe digest under the global base `stdpath("data")/glean`.
-- Falls back to the global base when the common dir can't be resolved.
function M.repo_state_dir(git)
  local base = vim.fn.stdpath("data") .. "/glean"
  local common = git:common_dir()
  if not common then return base end
  return base .. "/" .. vim.fn.sha256(common):sub(1, 16)
end

-- The worktree (content-addressed) shard id for an explicit review branch, or
-- `git`'s current branch when reviewing the checkout. Splits
-- the dual role of M.WORKTREE: the sentinel constant still identifies the
-- synthetic floating commit in control flow, while this branch-anchored id is
-- the *storage* shard under which uncommitted seen-marks and comments persist,
-- so switching branches no longer bleeds content-addressed state. A detached
-- HEAD shares a single `WORKTREE/HEAD` shard.
function M.wt_shard(git, branch)
  return state_mod.COMMENTS_ID .. "/" .. (branch or git:current_branch() or "HEAD")
end

local function range_identifier(base, target)
  local display_target = target == M.WORKTREE and "dirty" or target
  return ("%s..%s"):format(base, display_target)
end

local function review_title(git, identifier, base, target)
  local repo = vim.fn.fnamemodify(git.repo_root, ":t")
  local range = range_identifier(base, target)
  -- Keep branch names intact in filename-tail displays instead of letting
  -- Neovim interpret their slashes as path separators.
  local function display(ref) return ref:gsub("/", "∕") end
  if identifier == range then return ("Glean:%s %s"):format(repo, display(identifier)) end
  return ("Glean:%s %s [%s]"):format(repo, display(identifier), display(range))
end

local Session = {}
Session.__index = Session

-- Content-addressed collapse keys (stable across re-diffs / reloads): a commit
-- by its sha, a file by sha+path, a combined file by path.
local function commit_key(sha) return "c:" .. sha end
local function file_key(sha, path) return "f:" .. sha .. "\0" .. path end
local function cfile_key(path) return "cf:" .. path end
local function seen_key(sha, path) return "s:" .. sha .. "\0" .. path end
local function cseen_key(path) return "cs:" .. path end
-- Directory-grouping collapse keys: per (commit, dir prefix) in commit scope,
-- per dir prefix in combined scope.
local function dir_key(sha, prefix) return "d:" .. sha .. "\0" .. prefix end
local function cdir_key(prefix) return "cd:" .. prefix end

-- Flatten an ordered path list into a preorder directory tree: a `dir` entry per
-- directory component the moment it opens, then the files inside it. Pure and
-- order-preserving -- a directory that reappears later in the list (unsorted
-- input) simply opens a second row sharing the first one's collapse key. Each
-- dir entry carries `files`, the indices of every path beneath it, so a single
-- directory row can address them all.
-- Collapse single-child directory chains: `a/` holding only `b/` holding only
-- `c/` renders as one `a/b/c/` row, and a chain bottoming out at a lone file
-- renders as a single `a/b/c/file` row. Operates on the flat preorder list from
-- back to front so each subtree is already collapsed when its parent is
-- considered. A merged dir keeps the deepest prefix (and thus its collapse key);
-- its `files` set is unchanged since a chain link adds no siblings.
local function collapse_chains(out)
  for i = #out, 1, -1 do
    while out[i] and out[i].kind == "dir" do
      local depth = out[i].depth
      local last = i + 1
      while last <= #out and out[last].depth > depth do last = last + 1 end
      local kids = 0
      for k = i + 1, last - 1 do
        if out[k].depth == depth + 1 then kids = kids + 1 end
      end
      if kids ~= 1 then break end
      local child = out[i + 1]
      if child.kind == "file" then
        if last - i ~= 2 then break end
        child.name = out[i].name .. "/" .. child.name
        child.depth = depth
        table.remove(out, i)
        break
      end
      out[i].name = out[i].name .. "/" .. child.name
      out[i].prefix = child.prefix
      table.remove(out, i + 1)
      for k = i + 1, last - 2 do out[k].depth = out[k].depth - 1 end
    end
  end
  return out
end

local function dir_layout(paths)
  local out, open, nodes = {}, {}, {}
  for i, path in ipairs(paths) do
    local comps = vim.split(path, "/", { plain = true })
    local ndirs = #comps - 1
    local common = 0
    while common < #open and common < ndirs and open[common + 1] == comps[common + 1] do
      common = common + 1
    end
    for k = #open, common + 1, -1 do open[k], nodes[k] = nil, nil end
    for k = common + 1, ndirs do
      open[k] = comps[k]
      local node = {
        kind = "dir", depth = k - 1, name = comps[k],
        prefix = table.concat(comps, "/", 1, k), files = {},
      }
      nodes[k] = node
      out[#out + 1] = node
    end
    for k = 1, ndirs do
      local f = nodes[k].files
      f[#f + 1] = i
    end
    out[#out + 1] = { kind = "file", depth = ndirs, index = i, name = comps[#comps] }
  end
  return collapse_chains(out)
end

-- Content-addressed collapse key for a marker (a contiguous seen run inside an
-- unseen hunk). Keyed on the run's joined line texts so it stays stable when the
-- new-file line numbers shift (live/worktree) between renders.
local function marker_key(path, texts)
  return "mk:" .. path .. "\0" .. state_mod.line_hash(table.concat(texts, "\n"))
end
local function cmarker_key(path, texts)
  return "cmk:" .. path .. "\0" .. state_mod.line_hash(table.concat(texts, "\n"))
end

-- Build the review model for `base..target`: the net diff `files`, the ordered
-- `commits` (each with its own first-parent patch), and the `shas` to load from
-- the store. For a work-tree target the diff runs base->work tree and the
-- floating commit (tracked dirty edits + untracked files) is appended last.
-- In normal mode the commit list and ownership patches share one exact history
-- walk; ignore mode adds a separate display-history walk.

-- Assemble the active display model from parsed display patches. Cached commit
-- arrays are never mutated: the synthetic worktree commit and untracked files
-- are attached only to fresh per-model arrays.
local function assemble_model(worktree, files, patches, wt_files, untracked)
  for _, f in ipairs(files) do f.collapsed = false end
  local commits, shas = {}, {}
  for i, c in ipairs(patches) do
    commits[i] = { sha = c.sha, summary = c.summary, files = c.files }
    shas[#shas + 1] = c.sha
  end
  if worktree then
    local ffiles = {}
    for _, f in ipairs(wt_files or {}) do
      f.collapsed = false
      ffiles[#ffiles + 1] = f
    end
    for _, f in ipairs(untracked or {}) do
      local copy = vim.deepcopy(f)
      copy.collapsed = false
      ffiles[#ffiles + 1] = copy
    end
    -- `git diff <base>` (the combined net diff) omits untracked files, so attach
    -- them to the combined file list too. Each scope gets its own entry because
    -- collapse is ephemeral display state.
    for _, f in ipairs(untracked or {}) do
      local copy = vim.deepcopy(f)
      copy.collapsed = false
      files[#files + 1] = copy
    end
    commits[#commits + 1] = {
      sha = M.WORKTREE, summary = "uncommitted changes", files = ffiles, collapsed = false,
    }
    shas[#shas + 1] = M.WORKTREE
  end
  return files, commits, shas
end

local function cached_patches(cache, mode, head)
  local entry = cache and cache[mode]
  if entry and head and entry.head == head then return entry.patches end
  return nil
end

-- Fan out the active display projection and the exact ownership inputs. Exact
-- first-parent and worktree patches are always acquired even when display
-- patches use `--ignore-all-space`; only exact patches feed lineage. Committed
-- walks are cached independently by resolved target and normalized diff mode.
-- `cb(files, commits, shas, meta)` receives display files/commits plus
-- `meta.lineage_commits` and `meta.lineage_worktree_files` on success.
local function build_model_async(git, base, target, hints, cb)
  hints = hints or {}
  local worktree = target == M.WORKTREE
  local commit_target = worktree and "HEAD" or target
  local ignore_whitespace = hints.ignore_whitespace == true
  local cache_head = hints.head
  local exact_patches = cached_patches(hints.patch_cache, "exact", cache_head)
  local display_mode = ignore_whitespace and "ignore-all-space" or "exact"
  local display_patches = display_mode == "exact" and exact_patches
    or cached_patches(hints.patch_cache, display_mode, cache_head)
  local function net_diff(ignored, done)
    if worktree then
      git:diff_to_worktree_async(base, ignored, done)
    elseif hints.from_root then
      git:diff_async(base, target, ignored, done)
    else
      git:combined_diff_async(base, target, ignored, done)
    end
  end
  local jobs = {
    net = function(done) net_diff(ignore_whitespace, done) end,
  }
  if ignore_whitespace then
    jobs.exact_net = function(done) net_diff(false, done) end
  end
  if not exact_patches then
    if hints.from_root then
      jobs.exact_commits = function(done)
        git:log_patches_from_root_async(commit_target, false, done)
      end
    else
      jobs.exact_commits = function(done)
        git:log_patches_async(base, commit_target, false, done)
      end
    end
  end
  if ignore_whitespace and not display_patches then
    if hints.from_root then
      jobs.display_commits = function(done)
        git:log_patches_from_root_async(commit_target, true, done)
      end
    else
      jobs.display_commits = function(done)
        git:log_patches_async(base, commit_target, true, done)
      end
    end
  end
  if worktree then
    if not hints.wt_diff_text then
      jobs.exact_wt = function(done) git:worktree_diff_async(false, done) end
    end
    if ignore_whitespace then
      jobs.display_wt = function(done) git:worktree_diff_async(true, done) end
    end
    jobs.untracked = function(done) git:untracked_async(nil, done) end
  end
  -- Resolve the concrete committed target on the initial acquisition. It keys
  -- both history modes; callers that already resolved it (polls/mode switches)
  -- pass `hints.head` and can reuse a matching entry immediately.
  if not hints.head then
    jobs.head = function(done) git:run_async({ "rev-parse", commit_target }, done) end
  end
  git_mod.join(jobs, function(res)
    local files, ferr = res.net[1], res.net[2]
    if not files then return cb(nil, ferr) end
    local exact_reused = exact_patches ~= nil
    if not exact_patches then
      local err
      exact_patches, err = res.exact_commits[1], res.exact_commits[2]
      if not exact_patches then return cb(nil, err) end
    end
    if display_mode == "exact" then
      display_patches = exact_patches
    elseif not display_patches then
      local err
      display_patches, err = res.display_commits[1], res.display_commits[2]
      if not display_patches then return cb(nil, err) end
    end
    local exact_wt_files = hints.wt_diff_text and diff_mod.parse(hints.wt_diff_text)
      or (res.exact_wt and res.exact_wt[1] or nil)
    if worktree and not exact_wt_files then
      return cb(nil, res.exact_wt and res.exact_wt[2])
    end
    local display_wt_files = ignore_whitespace
      and (res.display_wt and res.display_wt[1] or nil) or exact_wt_files
    if worktree and ignore_whitespace and not display_wt_files then
      return cb(nil, res.display_wt and res.display_wt[2])
    end
    local untracked = res.untracked and res.untracked[1] or nil
    local canonical_files = ignore_whitespace and res.exact_net[1] or files
    if not canonical_files then return cb(nil, res.exact_net and res.exact_net[2]) end
    if worktree and ignore_whitespace then
      canonical_files = vim.deepcopy(canonical_files)
      for _, file in ipairs(untracked or {}) do
        canonical_files[#canonical_files + 1] = vim.deepcopy(file)
      end
    end
    local lineage_worktree_files = {}
    for _, file in ipairs(exact_wt_files or {}) do
      lineage_worktree_files[#lineage_worktree_files + 1] = file
    end
    for _, file in ipairs(untracked or {}) do
      lineage_worktree_files[#lineage_worktree_files + 1] = file
    end
    local f, c, s = assemble_model(worktree, files, display_patches,
      display_wt_files, untracked)
    local head = cache_head
      or (res.head and res.head[1] and (res.head[1]:gsub("%s+$", ""))) or nil
    local patch_cache = {}
    for mode, entry in pairs(hints.patch_cache or {}) do patch_cache[mode] = entry end
    patch_cache.exact = { head = head, patches = exact_patches }
    patch_cache[display_mode] = { head = head, patches = display_patches }
    cb(f, c, s, {
      patch_cache = patch_cache,
      lineage_commits = exact_patches,
      lineage_worktree_files = lineage_worktree_files,
      canonical_files = canonical_files,
      head = head,
      exact_reused = exact_reused,
    })
  end)
end

local CHEVRON_OPEN = "▼"
local CHEVRON_CLOSED = "▶"

-- The marker runs of a hunk: each maximal run of consecutive *changed* (add or
-- del) diff lines that `is_seen(dl)` reports seen. A context line or an unseen
-- changed line breaks the run, so a contiguous block of seen deletions collapses
-- into its own marker exactly like seen additions. Returns a list of descriptors
-- `{lo, hi_line, lnum_lo, lnum_hi, n, texts}` where `lo`/`hi_line` index into
-- `hunk.lines` (inclusive), `lnum_lo`/`lnum_hi` span the run's new-file lines
-- (nil across a pure-deletion run), and `texts` are the run's line texts (for
-- the content-addressed marker key).
local function hunk_marker_runs(hunk, is_seen)
  local runs = {}
  local cur = nil
  local function close()
    if cur then runs[#runs + 1] = cur end
    cur = nil
  end
  for i, dl in ipairs(hunk.lines) do
    local changed = dl.kind == "add" or dl.kind == "del"
    if changed and is_seen(dl, i) then
      if not cur then
        cur = { lo = i, hi_line = i, lnum_lo = dl.new_lnum, lnum_hi = dl.new_lnum, n = 1, texts = { dl.text } }
      else
        cur.hi_line = i
        cur.lnum_hi = dl.new_lnum or cur.lnum_hi
        cur.lnum_lo = cur.lnum_lo or dl.new_lnum
        cur.n = cur.n + 1
        cur.texts[#cur.texts + 1] = dl.text
      end
    else
      close()
    end
  end
  close()
  return runs
end

-- Display-only demotion of short seen runs (combined scope). Given the raw
-- marker `runs` from `hunk_marker_runs` (store-derived seen), a `threshold`, and
-- an `is_sticky(i)` predicate over `hunk.lines` indices, returns a per-index map
-- of which changed lines should still render as seen. A run of length
-- `>= threshold` keeps every line; a shorter run keeps only its sticky lines and
-- demotes the rest to plain unseen rows. `threshold <= 1` disables demotion
-- (every seen line stays). The persisted store is never consulted or mutated.
local function display_seen_map(runs, threshold, is_sticky)
  local map = {}
  local disabled = not threshold or threshold <= 1
  for _, run in ipairs(runs) do
    local keep_all = disabled or run.n >= threshold
    for i = run.lo, run.hi_line do
      if keep_all or (is_sticky and is_sticky(i)) then
        map[i] = true
      end
    end
  end
  return map
end

-- ---------------------------------------------------------------------------
-- Canonical seen resolver — the single representation everything folds over.
-- ---------------------------------------------------------------------------

-- The per-line owner closure for a commit-scope file: a changed line is owned
-- by its commit, keyed by new_lnum (adds) / old_lnum (dels). The floating
-- commit owns its lines as WORKTREE (content-addressed). `owner(dl) -> sha,lnum`.
function Session:commit_owner(commit)
  return function(dl)
    if commit.sha == M.WORKTREE then return M.WORKTREE end
    return commit.sha, dl.kind == "add" and dl.new_lnum or dl.old_lnum
  end
end

-- The per-line owner closure for a combined-scope file: an add line's owner is
-- its composed provenance (sha + that commit's own line number). A deletion is
-- owned by the commit that removed it (in that commit's immutable pre-image
-- coords), or WORKTREE when the removal is uncommitted.
function Session:combined_owner(path)
  local e = self._owner and self._owner[path]
  if not (e and e.status == "loaded") then
    -- Pending (ownership not yet loaded): every line is unowned, so the file's
    -- hunks render as unseen with identity nil. The diff text is already correct;
    -- only seen placement is deferred until the loader populates the cache.
    return function() return nil end
  end
  local prov, del_attr = e.prov, e.del_attr
  return function(dl)
    if dl.kind == "del" then
      local a = del_attr[dl.old_lnum]
      if a then return a.sha, a.lnum end
      return M.WORKTREE
    end
    if not dl.new_lnum then return nil end
    local p = prov[dl.new_lnum]
    -- An add line composition can't attribute (an untracked file has no patch
    -- at all, so its provenance map is empty) is uncommitted content in a work-tree
    -- review: route it to the content-addressed WORKTREE owner so it is markable.
    if not p then return self.worktree and M.WORKTREE or nil end
    return p.sha, p.lnum
  end
end

-- The explicit per-path ownership cache status, the single source of truth for
-- whether a combined file's composed ownership is available:
--   nil       — never requested
--   "loaded"  — forward provenance and del attribution are resolved & stored
function Session:owner_status(path)
  local e = self._owner and self._owner[path]
  return e and e.status or nil
end

-- Whether a render/action target's file has loaded ownership. A hunk's load
-- state is its file's load state (one composition resolves every file's hunks).
function Session:hunk_loaded(target)
  local path
  if self.scope == "commits" then return true end
  local cf = self.combined_files and self.combined_files[target.cfile]
  path = cf and cf.path
  return path ~= nil and self:owner_status(path) == "loaded"
end

-- Resolve combined-scope ownership for *every* path in one shot by composing
-- the exact ordered first-parent patches already fetched by `build_model` (plus
-- the exact floating work-tree layer last). Pure Lua, no additional subprocess;
-- display-only ignored patches never enter composition. Idempotent within a
-- model generation.
function Session:load_lineage()
  if self._owner then return self._owner end
  -- The committed layers depend only on (base, HEAD), so their composed state
  -- is cached across refreshes: a content-only reload re-applies just the
  -- work-tree layer over a clone of it (O(hunks) of pure Lua).
  local states = self._committed_states
  if not states then
    states = lineage.extend({}, self.lineage_commits or {})
    self._committed_states = states
  end
  if self.worktree then
    local wt = { sha = M.WORKTREE, files = self.lineage_worktree_files or {} }
    states = lineage.extend(lineage.clone(states), { wt })
  end
  local owner = {}
  for path, maps in pairs(lineage.finish(states)) do
    owner[path] = { status = "loaded", prov = maps.prov, del_attr = maps.del_attr }
  end
  -- A displayed file with no patch of its own (e.g. an untracked file whose
  -- content we couldn't read) still counts as loaded, with no owned lines.
  for _, cf in ipairs(self.combined_files or {}) do
    owner[cf.path] = owner[cf.path] or { status = "loaded", prov = {}, del_attr = {} }
  end
  self._owner = owner
  return owner
end

-- Resolve combined-scope ownership for the whole model. Bumps `_load_gen` so any
-- render still in flight from a prior model (a reload / scope change) drops
-- itself on its guard. No-op outside combined scope.
function Session:start_owner_loader()
  self._load_gen = (self._load_gen or 0) + 1
  if self.scope ~= "combined" then return end
  if self._suspended then return end
  self.combined_files = self.combined_files or self:compute_combined()
  self:load_lineage()
end

-- A deferred repaint, guarded by generation and buffer validity. Drops itself
-- when superseded (stale generation) or the buffer is gone.
function Session:streaming_render(gen)
  if gen ~= self._load_gen then return end
  if self._suspended then return end
  if not api.nvim_buf_is_valid(self.buf) then return end
  if not self._render_dirty then return end
  self._render_dirty = false
  self:render()
end



-- The stable seen-identity of one changed diff line, or nil for a context line
-- or a line with no in-range owner. A WORKTREE-owned line is content-addressed;
-- a committed add line is (sha, new_lnum); a committed del line is (sha, lnum).
-- `ord` is the line's flattened diff-line ordinal within its file; worktree
-- identities carry it so seen-ness is resolved positionally (block re-anchoring)
-- rather than by file-wide content match. Committed identities ignore it.
function Session:line_identity(dl, path, owner, ord)
  if dl.kind ~= "add" and dl.kind ~= "del" then return nil end
  local sha, lnum = owner(dl)
  if not sha then return nil end
  if sha == M.WORKTREE then
    local id = state_mod.wt_identity(path, dl.text)
    local display_file = self:file_for_path(path)
    id.ord = self:canonical_ordinal(display_file, dl) or ord
    return id
  end
  if dl.kind == "add" then return state_mod.add_identity(sha, path, lnum) end
  return state_mod.del_identity(sha, path, lnum)
end

-- The seen-identities of a hunk's changed (add/del) lines — the one place that
-- defines "which lines matter". Context lines and unowned lines are excluded.
-- `base_ord` is the flattened diff-line ordinal of the line *before* this hunk's
-- first line within its file (0 for the first hunk), so each line's ordinal is
-- `base_ord + index`. Worktree identities carry that ordinal for positional
-- (block) seen-resolution; committed identities ignore it. When omitted it
-- defaults to 0 (sufficient for committed-only callers).
function Session:changed_lines(hunk, path, owner, base_ord)
  base_ord = base_ord or 0
  local ids = {}
  for i, dl in ipairs(hunk.lines) do
    local id = self:line_identity(dl, path, owner, base_ord + i)
    if id then ids[#ids + 1] = id end
  end
  return ids
end

-- The flattened-ordinal base of each hunk within a file (hunk object -> count of
-- diff lines preceding it). Used to translate a per-hunk line index into the
-- file-wide ordinal worktree identities are addressed by.
local function hunk_base_ords(file)
  local bases, acc = {}, 0
  for _, h in ipairs(file.hunks) do
    bases[h] = acc
    acc = acc + #h.lines
  end
  return bases
end

-- Is a single line identity in the seen set? Worktree identities are resolved
-- positionally against the live diff (block re-anchoring); the rest delegate to
-- the store.
function Session:id_seen(id)
  if id.kind == "wt" then
    return id.ord ~= nil and self:wt_seen_ords(id.path)[id.ord] == true
  end
  return self.store:is_seen(id)
end

-- Are all of the given identities seen? (a hunk/file/commit fold)
function Session:ids_all_seen(ids)
  for _, id in ipairs(ids) do
    if not self:id_seen(id) then return false end
  end
  return true
end

-- Is a single line identity in the seen set?
function Session:line_seen(id)
  return self:id_seen(id)
end

-- A hunk is seen iff it has at least one changed line and every changed line's
-- identity is seen. This is the single predicate the renderer and the rollups
-- share, so placement and the header glyphs agree by construction.
function Session:hunk_seen(hunk, path, owner, base_ord)
  local ids = self:changed_lines(hunk, path, owner, base_ord)
  if #ids == 0 then return false end
  return self:ids_all_seen(ids)
end

-- Overall unreviewed work in the current scope. Lines count individually, while
-- a hunk/file remains unreviewed until all of its changed lines are seen.
function Session:progress_counts()
  local counts = { files = 0, hunks = 0, adds = 0, dels = 0 }
  local function count_file(file, owner)
    local file_unseen = false
    local bases = hunk_base_ords(file)
    for _, hunk in ipairs(file.hunks) do
      local hunk_unseen = false
      for i, dl in ipairs(hunk.lines) do
        if dl.kind == "add" or dl.kind == "del" then
          local id = self:line_identity(dl, file.path, owner, bases[hunk] + i)
          if not id or not self:id_seen(id) then
            hunk_unseen = true
            local key = dl.kind == "add" and "adds" or "dels"
            counts[key] = counts[key] + 1
          end
        end
      end
      if hunk_unseen then
        file_unseen = true
        counts.hunks = counts.hunks + 1
      end
    end
    if file_unseen then counts.files = counts.files + 1 end
  end
  if self.scope == "commits" then
    for _, commit in ipairs(self.commits) do
      local owner = self:commit_owner(commit)
      for _, file in ipairs(commit.files) do count_file(file, owner) end
    end
  else
    self.combined_files = self.combined_files or self:compute_combined()
    for _, file in ipairs(self.combined_files) do
      count_file(file, self:combined_owner(file.path))
    end
  end
  return counts
end

-- Is a file fully seen? (every hunk's changed lines seen)
function Session:file_seen(commit, file)
  local owner = self:commit_owner(commit)
  local bases = hunk_base_ords(file)
  for _, hunk in ipairs(file.hunks) do
    if not self:hunk_seen(hunk, file.path, owner, bases[hunk]) then return false end
  end
  return true
end

-- Is a whole commit fully seen?
function Session:commit_seen(commit)
  for _, file in ipairs(commit.files) do
    if not self:file_seen(commit, file) then return false end
  end
  return true
end

-- ---------------------------------------------------------------------------
-- Combined overlay: per-line ownership by patch composition (glean.lineage).
-- ---------------------------------------------------------------------------


-- The forward provenance map for a path, composing ownership on demand. Depends
-- only on target, so it survives seen-mark changes between renders.
function Session:provenance(path)
  return self:load_lineage()[path].prov
end

-- Project the raw combined diff into display files. Seen hunks are now rendered
-- in a collapsible per-file "seen" section by the shared body renderer, so this
-- is a thin pass that only applies the file-collapse override and exposes the
-- raw base..target hunks.
function Session:compute_combined()
  local out = {}
  for _, raw in ipairs(self.files) do
    local cov = self.collapse[cfile_key(raw.path)]
    if cov ~= nil then raw.collapsed = cov end
    out[#out + 1] = { path = raw.path, kind = raw.kind, hunks = raw.hunks, raw = raw }
  end
  return out
end

-- Flatten a file's hunks to its ordered diff-line list. This is the resolution
-- space comment `content[]` is matched against: only literal diff-line rows
-- (context/add/del), never decoration rows (headers, comments, summaries).
local function flatten_diff_lines(file)
  local out = {}
  for _, hunk in ipairs(file.hunks) do
    for _, dl in ipairs(hunk.lines) do
      out[#out + 1] = dl
    end
  end
  return out
end

-- The flattened diff-line ordinal of a (hunk, line) target within its file.
local function target_ordinal(file, target)
  local ord = 0
  for hi = 1, target.hunk - 1 do
    ord = ord + #file.hunks[hi].lines
  end
  return ord + target.line
end

-- The diff file a target row belongs to (commit scope: its commit's file;
-- combined scope: the cfile), or nil for non-diff rows.
function Session:row_file(target)
  if not target then return nil end
  if self.scope == "commits" then
    if not target.commit or not target.file then return nil end
    return self.commits[target.commit].files[target.file]
  end
  if not target.cfile then return nil end
  return self.combined_files[target.cfile]
end

-- Every diff file currently displayed, in document order.
function Session:displayed_files()
  local fs = {}
  if self.scope == "commits" then
    for _, c in ipairs(self.commits) do
      for _, f in ipairs(c.files) do fs[#fs + 1] = f end
    end
  else
    for _, cf in ipairs(self:compute_combined()) do fs[#fs + 1] = cf end
  end
  return fs
end

local function file_with_path(files, path)
  for _, file in ipairs(files or {}) do
    if file.path == path then return file end
  end
end

-- Return the exact diff file corresponding to a displayed file. Commit scope
-- uses the exact first-parent patch for that commit (or exact worktree patch);
-- combined scope uses the exact net diff. This keeps content-addressed review
-- records in one canonical ordinal space regardless of the active projection.
function Session:canonical_file(display_file)
  if not display_file then return nil end
  if self.scope == "combined" then
    return file_with_path(self.canonical_files, display_file.path)
  end
  for _, commit in ipairs(self.commits or {}) do
    for _, file in ipairs(commit.files) do
      if file == display_file then
        if commit.sha == M.WORKTREE then
          return file_with_path(self.lineage_worktree_files, file.path)
        end
        for _, exact in ipairs(self.lineage_commits or {}) do
          if exact.sha == commit.sha then return file_with_path(exact.files, file.path) end
        end
      end
    end
  end
end

local function line_coordinates_match(a, b)
  return a.kind == b.kind and a.text == b.text
    and a.old_lnum == b.old_lnum and a.new_lnum == b.new_lnum
end

local function line_ordinal(file, wanted)
  if not (file and wanted) then return nil end
  local ord = 0
  for _, hunk in ipairs(file.hunks) do
    for _, dl in ipairs(hunk.lines) do
      ord = ord + 1
      if line_coordinates_match(dl, wanted) then return ord end
    end
  end
end

local function line_at_ordinal(file, wanted)
  if not (file and wanted) then return nil end
  local ord = 0
  for _, hunk in ipairs(file.hunks) do
    for _, dl in ipairs(hunk.lines) do
      ord = ord + 1
      if ord == wanted then return dl end
    end
  end
end

-- The canonical exact ordinal for a displayed diff line. Real Git coordinates
-- plus exact text disambiguate repeated equal-content lines.
function Session:canonical_ordinal(display_file, dl)
  return line_ordinal(self:canonical_file(display_file), dl)
end

-- The displayed diff file holding `path`'s uncommitted lines: in commit scope
-- the synthetic worktree commit's file, in combined scope the combined file.
function Session:file_for_path(path)
  if self.scope == "commits" then
    for _, c in ipairs(self.commits) do
      if c.sha == M.WORKTREE then
        for _, f in ipairs(c.files) do
          if f.path == path then return f end
        end
      end
    end
    return nil
  end
  for _, cf in ipairs(self.combined_files or {}) do
    if cf.path == path then return cf end
  end
  return nil
end

-- Worktree seen records resolve against exact diff text, never the filtered
-- projection. Their stored anchors therefore survive whitespace-mode toggles.
function Session:wt_flat_texts(path)
  local file = self:canonical_file(self:file_for_path(path))
  if not file then return nil end
  local texts = {}
  for i, dl in ipairs(flatten_diff_lines(file)) do texts[i] = dl.text end
  return texts
end

function Session:wt_seen_ords(path)
  self._wt_seen = self._wt_seen or {}
  local cached = self._wt_seen[path]
  if cached then return cached end
  local set = {}
  local texts = self:wt_flat_texts(path)
  if texts then
    for _, rec in ipairs(self.store:seen_records(path)) do
      local start = state_mod.resolve(rec.content, rec.anchor, texts)
      if start then
        for k = 0, #rec.content - 1 do set[start + k] = true end
      end
    end
  end
  self._wt_seen[path] = set
  return set
end

-- Resolve comments in canonical exact space, then map the canonical anchor line
-- into this display file. A canonical match with no displayed counterpart is
-- hidden by whitespace mode, not outdated.
function Session:resolve_comments(file)
  local exact = self:canonical_file(file)
  local exact_flat = flatten_diff_lines(exact or file)
  if #exact_flat == 0 then return {} end
  local exact_texts = {}
  for i, dl in ipairs(exact_flat) do exact_texts[i] = dl.text end
  local by_ord = {}
  for _, rec in ipairs(self.store:comments_for(file.path)) do
    local start = state_mod.resolve(rec.content, rec.anchor, exact_texts)
    if start then
      local display_ord = line_ordinal(file, exact_flat[start])
      if display_ord then
        by_ord[display_ord] = by_ord[display_ord] or {}
        by_ord[display_ord][#by_ord[display_ord] + 1] = {
          path = file.path, anchor = rec.anchor, content = rec.content,
          text = rec.text, outdated = false, hidden = false,
        }
      end
    else
      local ord = math.max(1, math.min(rec.anchor or 1, #flatten_diff_lines(file)))
      by_ord[ord] = by_ord[ord] or {}
      by_ord[ord][#by_ord[ord] + 1] = {
        path = file.path, anchor = rec.anchor, content = rec.content,
        text = rec.text, outdated = true, hidden = false,
      }
    end
  end
  return by_ord
end

local function comment_key(rec)
  return tostring(rec.anchor) .. "\0" .. table.concat(rec.content, "\n") .. "\0" .. rec.text
end

-- Enumerate exact canonical files and their active display counterparts. Hidden
-- exact files remain present here so their comments stay discoverable.
function Session:comment_file_pairs()
  local pairs_out = {}
  if self.scope == "combined" then
    for _, exact in ipairs(self.canonical_files or {}) do
      pairs_out[#pairs_out + 1] = {
        exact = exact, display = file_with_path(self.combined_files or {}, exact.path),
      }
    end
    return pairs_out
  end
  for _, exact_commit in ipairs(self.lineage_commits or {}) do
    local display_commit
    for _, commit in ipairs(self.commits or {}) do
      if commit.sha == exact_commit.sha then display_commit = commit break end
    end
    for _, exact in ipairs(exact_commit.files) do
      pairs_out[#pairs_out + 1] = {
        exact = exact,
        display = display_commit and file_with_path(display_commit.files, exact.path) or nil,
      }
    end
  end
  if self.worktree then
    local display_commit = self.commits[#self.commits]
    for _, exact in ipairs(self.lineage_worktree_files or {}) do
      pairs_out[#pairs_out + 1] = {
        exact = exact,
        display = display_commit and file_with_path(display_commit.files, exact.path) or nil,
      }
    end
  end
  return pairs_out
end

function Session:collect_comments()
  local best = {}
  for _, pair in ipairs(self:comment_file_pairs()) do
    local flat = flatten_diff_lines(pair.exact)
    local texts = {}
    for i, dl in ipairs(flat) do texts[i] = dl.text end
    for _, rec in ipairs(self.store:comments_for(pair.exact.path)) do
      local start = state_mod.resolve(rec.content, rec.anchor, texts)
      local canonical_dl = flat[start or rec.anchor]
      local display_ord = start and pair.display and line_ordinal(pair.display, canonical_dl) or nil
      local entry = {
        anchor = rec.anchor, content = rec.content, line = rec.content[1] or "",
        lnum = canonical_dl and (canonical_dl.new_lnum or canonical_dl.old_lnum),
        outdated = start == nil,
        hidden = start ~= nil and display_ord == nil and self.ignore_whitespace,
        text = rec.text,
      }
      local path = pair.exact.path
      local rkey = comment_key(rec)
      best[path] = best[path] or {}
      local prev = best[path][rkey]
      local rank = entry.outdated and 0 or (entry.hidden and 1 or 2)
      local prev_rank = prev and (prev.outdated and 0 or (prev.hidden and 1 or 2)) or -1
      if rank > prev_rank then best[path][rkey] = entry end
    end
  end
  local order, by_path = {}, {}
  for path, recs in pairs(best) do
    order[#order + 1] = path
    local list = {}
    for _, entry in pairs(recs) do list[#list + 1] = entry end
    table.sort(list, function(a, b) return (a.anchor or 0) < (b.anchor or 0) end)
    by_path[path] = list
  end
  table.sort(order)
  return { order = order, by_path = by_path }
end

-- ---------------------------------------------------------------------------
-- Ancestry classification (pure): for each row, the ordered stack of enclosing
-- header rows (commit, file, section, hunk). Drives the sticky-header float.
-- Walks rows top-to-bottom carrying a running ancestry; a shallower header
-- clears deeper levels. Headers are identified purely from row_map target shape:
--   commit header  → { commit } (no file/cfile/sec/hunk)
--   seen section   → { ..., seen } (unseen hunks render bare, no section)
--   file header    → { file|cfile } (no hunk/line)
--   hunk header    → { ..., hunk } (no line, no marker)
function M.compute_ancestry(row_map, n)
  local ancestry = {}
  local commit_row, file_row, sec_row, hunk_row
  for row = 0, n - 1 do
    local t = row_map[row]
    if t then
      if t.commit and not t.file and not t.cfile and not t.sec and not t.hunk
          and not t.dir then
        commit_row, file_row, sec_row, hunk_row = row, nil, nil, nil
      elseif t.seen then
        sec_row, hunk_row = row, nil
      elseif (t.file or t.cfile) and not t.hunk and not t.line then
        file_row, sec_row, hunk_row = row, nil, nil
      elseif t.hunk and t.line == nil and t.marker == nil then
        hunk_row = row
      end
    end
    ancestry[row] = {
      commit_row = commit_row,
      file_row = file_row,
      sec_row = sec_row,
      hunk_row = hunk_row,
    }
  end
  return ancestry
end

-- Pinned-set selection (pure): once the top summary row scrolls away it is
-- always pinned, followed by the enclosing [commit, file, sec, hunk] headers
-- strictly above w0. An empty list means no float should be shown.
-- The float text for a pinned row (pure). A file header renders its basename
-- indented under directory rows, but the float has no enclosing directory rows
-- for context, so it shows the full path flush left instead.
function M.sticky_text(line, path)
  if not path then return line end
  local rest = line:match("^%s*(.*)$")
  -- The buffer shows some suffix of the path (a basename, or several components
  -- when a single-child directory chain was collapsed into the file row); swap
  -- the longest such suffix present for the full path.
  local comps = vim.split(path, "/", { plain = true })
  for k = 1, #comps do
    local suffix = table.concat(comps, "/", k)
    if rest:find(suffix, 1, true) then
      return (rest:gsub(vim.pesc(suffix), function() return path end, 1))
    end
  end
  return rest
end

function M.compute_pinned(ancestry, w0)
  local pinned = {}
  local a = ancestry[w0]
  if not a then
    return pinned
  end
  if w0 > 0 then pinned[#pinned + 1] = 0 end
  for _, row in ipairs({ a.commit_row or false, a.file_row or false,
    a.sec_row or false, a.hunk_row or false }) do
    if row and row < w0 then
      pinned[#pinned + 1] = row
    end
  end
  return pinned
end

-- ---------------------------------------------------------------------------
-- Build (pure projection): returns lines, row_map, highlights, comments.
-- ---------------------------------------------------------------------------

function Session:build()
  -- Worktree seen-marks are resolved positionally against the live diff; the
  -- per-path ord cache is rebuilt each render since the diff may have changed.
  self._wt_seen = {}
  local lines = {}
  local row_map = {}
  local highlights = {}
  local intra_blocks = {}
  local sections = {}
  -- Top-level section boundaries: each contiguous run of rows produced by one
  -- build() unit, with a stable, order-stable key. `render()` ignores these in
  -- Stage 1; later stages diff sections to apply minimal buffer mutations.
  local function section(key, fn)
    local lo = #lines
    fn()
    sections[#sections + 1] = { key = key, lo = lo, hi = #lines }
  end
  local function emit(text, target, hl)
    -- The buffer is a pure line-projection: every row must be a single line.
    -- Defend the `nvim_buf_set_lines` contract at the sole row-append site so a
    -- stray newline in any source value (worktree/comment content) can never
    -- crash the renderer (and, via a half-finished reload, corrupt loader state).
    if text:find("[\r\n]") then text = text:gsub("[\r\n]", " ") end
    lines[#lines + 1] = text
    local row = #lines - 1
    row_map[row] = target
    if hl then highlights[#highlights + 1] = { row = row, hl = hl } end
    return row
  end

  -- A stored comment rendered as real, cursor-addressable buffer rows (multi-
  -- line text splits across rows). Every row carries the same comment identity
  -- (path + record) so `dd`/`i`/`dc` anywhere on it acts on the whole comment.
  local function emit_comment(c, htarget)
    local ctarget = vim.tbl_extend("force", htarget or {}, { comment = c })
    local lead = c.outdated and "> (outdated) " or "> "
    local hl = c.outdated and "GleanSeen" or "GleanComment"
    for _, part in ipairs(vim.split(c.text, "\n", { plain = true })) do
      emit(lead .. part, ctarget, hl)
    end
  end

  local function emit_hunk(hunk, hi, target_base, owner, base_ord, comments_by_ord, sec, path)
    local target = vim.tbl_extend("force", target_base, { hunk = hi, sec = sec })
    emit("--- " .. hunk.header, target, "GleanHunkHeader")
    -- Markers are an unseen-hunk affordance only: a hunk in the seen section is
    -- fully seen and always renders whole, never collapsing sub-ranges. A run is
    -- any contiguous block of seen changed lines (adds or dels), via the shared
    -- line-identity predicate.
    local seen_line = function(dl, li)
      local id = self:line_identity(dl, path, owner, base_ord + li)
      return id ~= nil and self:id_seen(id)
    end
    local runs = sec == "seen" and {} or hunk_marker_runs(hunk, seen_line)
    -- Combined scope only: demote short seen runs interleaved with newer unseen
    -- changes to plain unseen rows, re-deriving markers from the resulting
    -- per-line display-seen predicate. Store-derived section placement above is
    -- untouched; this only changes how a partially-seen hunk looks inside.
    if self.scope == "combined" and sec ~= "seen" then
      local is_sticky = function(li)
        return self.store:is_sticky(path, hunk.lines[li].text)
      end
      local display = display_seen_map(runs, self.min_seen_run, is_sticky)
      runs = hunk_marker_runs(hunk, function(_, li) return display[li] == true end)
    end
    local run_at = {}
    for _, run in ipairs(runs) do run_at[run.lo] = run end
    -- Intra-line emphasis pairs deleted lines against added lines by textual
    -- similarity, so it must only ever see one replace group at a time: a del
    -- run paired with the add run immediately following it. flush accumulates
    -- the current del/add run as a block and resets. The group breaks on a
    -- context line, a marker run, or a del that starts a fresh group after adds.
    local dels, adds = {}, {}
    local function flush()
      if #dels > 0 and #adds > 0 then
        intra_blocks[#intra_blocks + 1] = { dels = dels, adds = adds }
      end
      dels, adds = {}, {}
    end
    local li = 1
    while li <= #hunk.lines do
      local run = run_at[li]
      if run then
        local mk = (self.scope == "combined")
          and cmarker_key(path, run.texts) or marker_key(path, run.texts)
        local collapsed = self.collapse[mk]
        if collapsed == nil then collapsed = true end
        local mtarget = vim.tbl_extend("force", target, { marker = {
          lo = run.lo, hi_line = run.hi_line,
          lnum_lo = run.lnum_lo, lnum_hi = run.lnum_hi,
          n = run.n, texts = run.texts,
        } })
        local label = ("marked %d line%s"):format(run.n, run.n == 1 and "" or "s")
        if collapsed then
          emit("  ✓ " .. label, mtarget, "GleanSeen")
        else
          emit("  " .. CHEVRON_OPEN .. " ✓ " .. label, mtarget, "GleanSeen")
          for ri = run.lo, run.hi_line do
            local dl = hunk.lines[ri]
            local m = dl.kind == "add" and "+" or dl.kind == "del" and "-" or " "
            emit(m .. dl.text,
              vim.tbl_extend("force", mtarget, { line = ri }), "GleanSeen")
            for _, c in ipairs(comments_by_ord[base_ord + ri] or {}) do
              emit_comment(c, target)
            end
          end
        end
        flush()
        li = run.hi_line + 1
      else
        local dl = hunk.lines[li]
        local m = dl.kind == "add" and "+" or dl.kind == "del" and "-" or " "
        local hl = dl.kind == "add" and "GleanAdd"
          or dl.kind == "del" and "GleanDel"
          or "GleanContext"
        local row = emit(m .. dl.text,
          vim.tbl_extend("force", target, { line = li }), hl)
        if dl.kind == "del" then
          if #adds > 0 then flush() end
          dels[#dels + 1] = { row = row, text = dl.text }
        elseif dl.kind == "add" then
          adds[#adds + 1] = { row = row, text = dl.text }
        else
          flush()
        end
        for _, c in ipairs(comments_by_ord[base_ord + li] or {}) do
          emit_comment(c, target)
        end
        li = li + 1
      end
    end
    -- Defer the expensive intra-line pairing/alignment to the async phase: emit
    -- only the raw del/add rows+texts per hunk. Phase 1's whole-line highlight
    -- stands until the refinement upgrades it.
    flush()
  end

  local function emit_file_body(file, target_base, owner, seen_ck, comments_by_ord, indent)
    local seen_idx, unseen_idx = {}, {}
    local base_ord = {}
    local acc = 0
    for hi, hunk in ipairs(file.hunks) do
      base_ord[hi] = acc
      acc = acc + #hunk.lines
      if self:hunk_seen(hunk, file.path, owner, base_ord[hi]) then seen_idx[#seen_idx + 1] = hi
      else unseen_idx[#unseen_idx + 1] = hi end
    end
    -- The seen section sits on top as the only collapsible region: a
    -- "seen (N hunks)" toggle, default collapsed. When expanded, the seen hunks
    -- show and a "--- unseen ---" divider marks where the bare unseen work below
    -- begins.
    local emitted_hunk = false
    local function emit_body_hunk(hi, sec)
      if emitted_hunk then emit("", {}) end
      emit_hunk(file.hunks[hi], hi, target_base, owner, base_ord[hi], comments_by_ord, sec, file.path)
      emitted_hunk = true
    end
    local seen_expanded = false
    if #seen_idx > 0 then
      local c = self.collapse[seen_ck]; if c == nil then c = true end
      seen_expanded = not c
      local chev = c and CHEVRON_CLOSED or CHEVRON_OPEN
      emit(("%s%s seen (%d hunks)"):format(indent, chev, #seen_idx),
        vim.tbl_extend("force", target_base, { seen = true }), "GleanSeen")
      if not c then
        for _, hi in ipairs(seen_idx) do
          emit_body_hunk(hi, "seen")
        end
      end
    end
    -- Unseen hunks render bare below -- there is no "unseen" section to
    -- collapse; they fold away with the file itself. A divider separates them
    -- from the expanded seen hunks above.
    if seen_expanded and #unseen_idx > 0 then
      emit("--- unseen ---", target_base, "GleanDivider")
    end
    for _, hi in ipairs(unseen_idx) do
      emit_body_hunk(hi, "unseen")
    end
  end

  -- Collapsed rows hide their hunks, so they carry the tally instead. Only
  -- computed for collapsed rows: the traversal walks every changed line beneath
  -- the target.
  local function summary(target)
    local seen, total = self:hunk_summary(target)
    if total == 0 then return "" end
    return ("  (%d seen / %d unseen)"):format(seen, total - seen)
  end
  local mode_label = self.scope == "combined" and "combined" or "commit-by-commit"
  if self.ignore_whitespace then mode_label = mode_label .. " · ignore-whitespace" end
  local progress = self:progress_counts()
  local function count_label(n, singular, plural)
    return ("%d %s"):format(n, n == 1 and singular or plural)
  end
  section("header", function()
    emit(("── %s ──  unreviewed: %s / %s / %s / %s"):format(mode_label,
      count_label(progress.files, "file", "files"),
      count_label(progress.hunks, "hunk", "hunks"),
      count_label(progress.adds, "added line", "added lines"),
      count_label(progress.dels, "deleted line", "deleted lines")),
      {}, "GleanModeHeader")
  end)
  if self.scope == "commits" then
    for ci, commit in ipairs(self.commits) do
     section("commit:" .. commit.sha, function()
      local mark = self:commit_seen(commit) and "✓" or "●"
      local short = commit.sha:sub(1, 8)
      local target = { commit = ci }
      local chevron = commit.collapsed and CHEVRON_CLOSED or CHEVRON_OPEN
      emit(("%s %s %s %s%s"):format(chevron, mark, short, commit.summary,
        commit.collapsed and summary(target) or ""), target, "GleanCommitHeader")
      if not commit.collapsed then
        local paths = {}
        for fi, f in ipairs(commit.files) do paths[fi] = f.path end
        local skip
        for _, node in ipairs(dir_layout(paths)) do
        if skip and node.depth <= skip then skip = nil end
        if not skip then
          local indent = ("  "):rep(node.depth)
          if node.kind == "dir" then
            local key = dir_key(commit.sha, node.prefix)
            local collapsed = self.collapse[key] or false
            local seen = true
            for _, i in ipairs(node.files) do
              if not self:file_seen(commit, commit.files[i]) then seen = false break end
            end
            local dtarget = { commit = ci, dir = node.prefix, dirfiles = node.files }
            emit(("%s%s %s %s/%s"):format(indent, collapsed and CHEVRON_CLOSED or CHEVRON_OPEN,
              seen and "✓" or " ", node.name, collapsed and summary(dtarget) or ""),
              dtarget, "GleanFileHeader")
            if collapsed then skip = node.depth end
          else
            local fi, file = node.index, commit.files[node.index]
            local fchev = file.collapsed and CHEVRON_CLOSED or CHEVRON_OPEN
            local fmark = self:file_seen(commit, file) and "✓" or " "
            local kind = file.kind and (" [" .. file.kind .. "]") or ""
            local ftarget = { commit = ci, file = fi }
            emit(("%s%s %s %s%s%s"):format(indent, fchev, fmark, node.name, kind,
              file.collapsed and summary(ftarget) or ""), ftarget, "GleanFileHeader")
            if not file.collapsed then
              emit_file_body(file, { commit = ci, file = fi },
                self:commit_owner(commit),
                seen_key(commit.sha, file.path), self:resolve_comments(file), indent .. "  ")
            end
          end
        end
        end
      end
     end)
    end
  else
    self.combined_files = self:compute_combined()
    local cpaths = {}
    for i, cf in ipairs(self.combined_files) do cpaths[i] = cf.path end
    local cskip
    local layout = dir_layout(cpaths)
    for ni, node in ipairs(layout) do
      if cskip and node.depth <= cskip then cskip = nil end
      if not cskip and node.kind == "dir" then
        section("dir:" .. ni .. ":" .. node.prefix, function()
          local key = cdir_key(node.prefix)
          local collapsed = self.collapse[key] or false
          local dtarget = { dir = node.prefix, dirfiles = node.files }
          emit(("%s%s %s/%s"):format(("  "):rep(node.depth),
            collapsed and CHEVRON_CLOSED or CHEVRON_OPEN, node.name,
            collapsed and summary(dtarget) or ""), dtarget, "GleanFileHeader")
          if collapsed then cskip = node.depth end
        end)
      elseif not cskip then
       local fi = node.index
       local cf = self.combined_files[fi]
       section("cf:" .. cf.path, function()
      local chevron = cf.raw.collapsed and CHEVRON_CLOSED or CHEVRON_OPEN
      local kind = cf.kind and (" [" .. cf.kind .. "]") or ""
      -- Ownership not yet resolved: stamp every row of this file `pending` so the
      -- action layer treats it as inert (no markable identity). The diff text is
      -- already correct; only seen placement is deferred until the loader runs.
      local pending = self:owner_status(cf.path) ~= "loaded" or nil
      local tb = { cfile = fi, pending = pending }
      -- Pending files render an explicit "loading" placeholder rather than the
      -- full diff: with ownership unresolved every line would resolve as unseen,
      -- so painting the body now would flash the whole file as unmarked and then
      -- restream it into its seen placement once the loader lands. Withholding
      -- the body until "loaded" makes the transition go loading -> settled.
      local badge = pending and "  ⟳ loading…" or ""
      local tally = (cf.raw.collapsed and not pending) and summary(tb) or ""
      emit(("  "):rep(node.depth) .. chevron .. " " .. node.name .. kind .. badge .. tally,
        tb, "GleanFileHeader")
      if not cf.raw.collapsed then
        if pending then
          emit("  ⟳ resolving review state…", tb, "GleanSeen")
        else
          emit_file_body(cf, tb, self:combined_owner(cf.path),
            cseen_key(cf.path), self:resolve_comments(cf), ("  "):rep(node.depth + 1))
        end
      end
       end)
      end
    end
  end

  local summary = self:collect_comments()
  if #summary.order > 0 then
   section("comments", function()
    emit("", {})
    emit("══ comments ══", {}, "GleanModeHeader")
    for _, path in ipairs(summary.order) do
      -- `<CR>` on the file row jumps to that file's header in the diff above.
      emit(path, { summary_file = path }, "GleanFileHeader")
      for _, e in ipairs(summary.by_path[path]) do
        local loc = e.outdated and "(Outdated)"
          or e.hidden and "(Hidden by whitespace mode)"
          or (e.lnum and ("L%d"):format(e.lnum) or "L?")
        -- The comment record carried so `dd`/`i`/`e` act on it directly, plus
        -- `summary_comment` so `<CR>` expands its hunk and jumps to it above.
        local c = {
          path = path, anchor = e.anchor, content = e.content, text = e.text,
          outdated = e.outdated, hidden = e.hidden,
        }
        local ctarget = { comment = c, summary_comment = { path = path } }
        emit(("  %s  %s"):format(loc, e.line), ctarget,
          (e.outdated or e.hidden) and "GleanSeen" or "GleanContext")
        for _, part in ipairs(vim.split(e.text, "\n", { plain = true })) do
          emit("> " .. part, ctarget, "GleanComment")
        end
      end
    end
   end)
  end

  return lines, row_map, highlights, intra_blocks, sections
end

-- A render is a no-op when `build()` reproduces the previous projection
-- byte-for-byte. The signature folds in each row's `pending` flag (ownership-
-- derived state that can flip without changing line *text*), so a streaming
-- re-render that finds nothing actually changed — the common case for a fresh,
-- unmarked review where every file loads into the same placement — skips the
-- whole-buffer set_lines + extmark teardown rather than repainting identically.
function Session:render_sig(lines, row_map)
  local pend = {}
  for row, t in pairs(row_map) do
    if t and t.pending then pend[#pend + 1] = row end
  end
  table.sort(pend)
  return table.concat(lines, "\n") .. "\0" .. table.concat(pend, ",")
end

-- Per-section content signatures (Stage 2). For each `{key, lo, hi}` section
-- emitted by `build()`, fold its slice of `lines`, the highlight tuples whose
-- row falls in `[lo, hi)`, and the `pending` rows in that span into one string.
-- This is `render_sig` applied to a row sub-range: it captures everything that
-- determines the visible result for those rows, so a section is dirty exactly
-- when its projection changed.
function Session:section_sigs(lines, row_map, highlights, sections)
  local hls_by_row = {}
  for _, hl in ipairs(highlights) do
    hls_by_row[hl.row] = (hls_by_row[hl.row] or "") .. "\1" .. hl.hl
  end
  local out = {}
  for _, sec in ipairs(sections) do
    local parts = {}
    for row = sec.lo, sec.hi - 1 do
      parts[#parts + 1] = lines[row + 1] or ""
      local h = hls_by_row[row]
      if h then parts[#parts + 1] = "\2" .. h end
      local t = row_map[row]
      if t and t.pending then parts[#parts + 1] = "\3" end
    end
    out[sec.key] = {
      sig = table.concat(parts, "\n"),
      lo = sec.lo,
      hi = sec.hi,
    }
  end
  return out
end

-- Compute the dirty set: keys that are new, gone, or whose signature changed
-- between the last paint (`prev`) and the new section signatures (`cur`).
-- A section that only shifted row position (same sig) is not dirty.
local function dirty_sections(prev, cur)
  local dirty = {}
  for key, c in pairs(cur) do
    local p = prev[key]
    if not p or p.sig ~= c.sig then dirty[key] = true end
  end
  for key in pairs(prev) do
    if not cur[key] then dirty[key] = true end
  end
  return dirty
end

function Session:render()
  if not (api.nvim_buf_is_valid(self.buf) and api.nvim_buf_is_loaded(self.buf)) then return end
  local lines, row_map, highlights, intra_work, sections = self:build()
  local sigs = self:section_sigs(lines, row_map, highlights, sections)
  local prev = self._sections
  local dirty = dirty_sections(prev or {}, sigs)
  self._dirty = dirty
  if next(dirty) == nil then
    self._sections = sigs
    return
  end
  self._render_sig = self:render_sig(lines, row_map)
  self.row_map = row_map
  self.ancestry = M.compute_ancestry(row_map, #lines)
  -- Each render rebuilds ancestry/row_hl in lockstep with row_map; bumping the
  -- generation invalidates the sticky-float guard so it re-evaluates below.
  self._render_gen = (self._render_gen or 0) + 1
  self.row_hl = {}
  for _, hl in ipairs(highlights) do
    self.row_hl[hl.row] = hl.hl
  end
  local win = self.win
  local cur
  if win and api.nvim_win_is_valid(win) then
    cur = api.nvim_win_get_cursor(win)
  end

  -- Group highlights by their (new-layout) absolute row, so a section's
  -- re-stamp can pull only the highlights that fall inside it.
  local hls_by_row = {}
  for _, hl in ipairs(highlights) do
    local b = hls_by_row[hl.row]
    if not b then
      b = {}
      hls_by_row[hl.row] = b
    end
    b[#b + 1] = hl
  end
  -- Stamp the full-line NS extmark for one highlight at `at_row` (its position
  -- in the buffer's *current* state), recording add/del marks under `key_row`
  -- (its position in the *new* layout, where it will land once all edits settle
  -- and where apply_intraline looks it up).
  -- Each full-line NS mark spans into the next line (end_row+1) so it covers the
  -- EOL; that means clearing a section's line range with clear_namespace would
  -- also wipe the *previous* section's last-line mark (it overlaps the boundary).
  -- So we track each section's NS mark ids and delete by id on re-stamp, leaving
  -- neighbors untouched. `at_row` is the section's current buffer row; `key_row`
  -- is its final-layout row (where apply_intraline looks up add/del marks).
  local function stamp(hl, at_row, key_row, ids)
    local id = api.nvim_buf_set_extmark(self.buf, NS, at_row, 0, {
      end_row = at_row + 1,
      end_col = 0,
      hl_group = hl.hl,
      hl_eol = true,
    })
    ids[#ids + 1] = id
    if hl.hl == "GleanAdd" or hl.hl == "GleanDel" then
      self._line_marks[key_row] = { id = id, base = hl.hl }
    end
  end

  -- A render is structural (forcing a full repaint) when it is the first paint
  -- or when the set of section keys changed (scope toggle, file added/removed on
  -- reload). With the key set stable, sections keep document order, so the
  -- incremental per-section apply is well defined.
  local structural = prev == nil
  if not structural then
    for key in pairs(sigs) do
      if not prev[key] then structural = true break end
    end
  end
  if not structural then
    for key in pairs(prev) do
      if not sigs[key] then structural = true break end
    end
  end

  api.nvim_set_option_value("modifiable", true, { buf = self.buf })
  if structural then
    api.nvim_buf_set_lines(self.buf, 0, -1, false, lines)
    api.nvim_buf_clear_namespace(self.buf, NS, 0, -1)
    -- Per-row full-line extmark ids for add/del lines, so phase-2 can downgrade
    -- an aligned line's background to foreground-only (the emphasis layer then
    -- paints just the changed spans with the diff background).
    self._line_marks = {}
    self._sec_marks = {}
    for _, sec in ipairs(sections) do
      local ids = {}
      for row = sec.lo, sec.hi - 1 do
        for _, hl in ipairs(hls_by_row[row] or {}) do
          stamp(hl, row, row, ids)
        end
      end
      self._sec_marks[sec.key] = ids
    end
    self:apply_intraline(intra_work)
  else
    self._line_marks = self._line_marks or {}
    self._sec_marks = self._sec_marks or {}
    -- Dirty sections in document order; applied bottom-to-top so each edit only
    -- shifts rows below it (already final), keeping every higher section's *old*
    -- range valid as the cursor of edits moves upward. Each section's content is
    -- written at its OLD range but is the NEW slice; extmarks are stamped at the
    -- section's current (old) rows and ride the later upper edits down to their
    -- final (new) positions automatically.
    local dirty_secs = {}
    for _, sec in ipairs(sections) do
      if dirty[sec.key] then dirty_secs[#dirty_secs + 1] = sec end
    end
    for i = #dirty_secs, 1, -1 do
      local sec = dirty_secs[i]
      local p = prev[sec.key]
      local slice = {}
      for row = sec.lo, sec.hi - 1 do
        slice[#slice + 1] = lines[row + 1]
      end
      api.nvim_buf_set_lines(self.buf, p.lo, p.hi, false, slice)
      for _, id in ipairs(self._sec_marks[sec.key] or {}) do
        api.nvim_buf_del_extmark(self.buf, NS, id)
      end
      local ids = {}
      for row = sec.lo, sec.hi - 1 do
        local at = p.lo + (row - sec.lo)
        for _, hl in ipairs(hls_by_row[row] or {}) do
          stamp(hl, at, row, ids)
        end
      end
      self._sec_marks[sec.key] = ids
    end
    local ranges = {}
    for _, sec in ipairs(dirty_secs) do
      ranges[#ranges + 1] = { lo = sec.lo, hi = sec.hi }
    end
    self:apply_intraline(intra_work, ranges)
  end
  api.nvim_set_option_value("modifiable", false, { buf = self.buf })
  self._sections = sigs

  if cur then
    local last = math.max(1, #lines)
    cur[1] = math.min(cur[1], last)
    pcall(api.nvim_win_set_cursor, win, cur)
  end
  self:highlight_cursor_hunk()
  self:update_sticky()
end

-- Phase 2 of rendering: intra-line (word-level) emphasis, computed off the
-- synchronous render path. `build()` emits only raw del/add blocks; the
-- expensive pairing + token alignment (intraline.refine) runs here, chunked via
-- vim.schedule, so the buffer first shows whole-line add/del highlighting and
-- upgrades to changed-span emphasis as each block is refined.
--
-- Refinement is content-addressable (independent of buffer rows), so results are
-- cached by the block's del/add text in `self._intra_cache` and reused across
-- re-renders (mark/collapse) and reloads (save) -- an unchanged hunk is refined
-- exactly once. The caller maps the cached di/ai indices back to current rows.
--
-- Each render bumps `self._intra_gen` and clears NS_INTRA synchronously; every
-- chunk re-checks (via intraline.is_current) that its captured generation still
-- matches and the buffer is still valid, so a re-render/reload mid-flight
-- abandons stale work. INTRA_BUDGET bounds the del+add lines refined per tick.
local INTRA_BUDGET = 40
function Session:apply_intraline(blocks, ranges)
  self._intra_gen = (self._intra_gen or 0) + 1
  local gen = self._intra_gen
  -- Incremental render passes the dirty sections' (new-layout) row ranges: clear
  -- NS_INTRA and refine blocks only within them, so untouched sections keep their
  -- emphasis extmarks (auto-shifted by set_lines). A full repaint passes no
  -- ranges and clears/refines the whole buffer.
  if ranges then
    for _, r in ipairs(ranges) do
      api.nvim_buf_clear_namespace(self.buf, NS_INTRA, r.lo, r.hi)
    end
    local function in_dirty(row)
      for _, r in ipairs(ranges) do
        if row >= r.lo and row < r.hi then return true end
      end
      return false
    end
    local kept = {}
    for _, b in ipairs(blocks) do
      local row = (b.dels[1] and b.dels[1].row) or (b.adds[1] and b.adds[1].row)
      if row and in_dirty(row) then kept[#kept + 1] = b end
    end
    blocks = kept
  else
    api.nvim_buf_clear_namespace(self.buf, NS_INTRA, 0, -1)
  end
  if #blocks == 0 then
    return
  end
  self._intra_cache = self._intra_cache or {}
  -- Downgrade an aligned line's full-line background (placed in phase 1) to a
  -- foreground-only color, by re-setting its extmark in place. The changed spans
  -- then carry the diff background, so emphasis reads as "background = changed".
  local TEXT_HL = { GleanAdd = "GleanAddText", GleanDel = "GleanDelText" }
  local function downgrade(row)
    local mark = self._line_marks and self._line_marks[row]
    if not mark then
      return
    end
    api.nvim_buf_set_extmark(self.buf, NS, row, 0, {
      id = mark.id,
      end_row = row + 1,
      end_col = 0,
      hl_group = TEXT_HL[mark.base],
      hl_eol = true,
    })
  end
  -- Rows/segments are captured from the render that produced `blocks`; an
  -- interleaved buffer change (live poll reload, incremental re-render) can make
  -- them outrun the current line, so clamp to the real line length and skip rows
  -- that no longer exist rather than letting set_extmark raise.
  local function paint(row, segs, hl)
    local line = api.nvim_buf_get_lines(self.buf, row, row + 1, false)[1]
    if not line then return end
    local len = #line
    for _, seg in ipairs(segs) do
      local s = math.min(1 + seg.start_col, len)
      local e = math.min(1 + seg.end_col, len)
      if e > s then
        api.nvim_buf_set_extmark(self.buf, NS_INTRA, row, s, {
          end_row = row,
          end_col = e,
          hl_group = hl,
          priority = 4200,
        })
      end
    end
  end
  local bi = 1
  local function step()
    if not intraline.is_current(gen, self._intra_gen, api.nvim_buf_is_valid(self.buf)) then
      return
    end
    local budget = 0
    while bi <= #blocks and budget < INTRA_BUDGET do
      local block = blocks[bi]
      bi = bi + 1
      budget = budget + #block.dels + #block.adds
      local del_texts, add_texts = {}, {}
      for _, d in ipairs(block.dels) do del_texts[#del_texts + 1] = d.text end
      for _, a in ipairs(block.adds) do add_texts[#add_texts + 1] = a.text end
      -- Content-addressed cache key: the del/add line texts fully determine the
      -- refinement, so an unchanged hunk hits the cache across re-renders/reloads.
      local key = table.concat(del_texts, "\n") .. "\0\0" .. table.concat(add_texts, "\n")
      local refined = self._intra_cache[key]
      if not refined then
        refined = intraline.refine(del_texts, add_texts)
        self._intra_cache[key] = refined
      end
      -- Map the cached di/ai indices back to this render's rows. Only drop a
      -- side's full-line background when it has changed spans to paint; an empty
      -- seg list means that line is unchanged and keeps its full-line highlight.
      -- A pair means we resolved what changed, so both lines drop their
      -- full-line background and read as text; the changed spans (which may be
      -- on only one side, e.g. a pure in-line insertion) then carry the diff
      -- background. Downgrading unconditionally keeps the unchanged side from
      -- staying solid -- the "we gave up" look -- when only its mate changed.
      for _, r in ipairs(refined) do
        downgrade(block.dels[r.di].row)
        downgrade(block.adds[r.ai].row)
        paint(block.dels[r.di].row, r.a_segs, "GleanDelEmph")
        paint(block.adds[r.ai].row, r.b_segs, "GleanAddEmph")
      end
    end
    if bi <= #blocks then
      vim.schedule(step)
    end
  end
  vim.schedule(step)
end

-- Shift the active hunk body to the right while keeping its header fixed, and
-- retain the gutter bar as a secondary boundary cue. Inline virtual text keeps
-- this display-only: row_map and the read-only buffer projection stay unchanged.
function Session:highlight_cursor_hunk()
  if not (self.buf and api.nvim_buf_is_valid(self.buf)) then return end
  if not (self.win and api.nvim_win_is_valid(self.win)) then return end
  local t = self.row_map[self:cursor_row()]
  local state = (t and t.hunk) and table.concat({
    t.commit or 0, t.file or 0, t.cfile or 0, t.hunk, self._render_gen or 0,
  }, ":") or ("none:" .. (self._render_gen or 0))
  if self._cursor_hunk_state == state then return end
  self._cursor_hunk_state = state
  self._cursor_indent_gen = (self._cursor_indent_gen or 0) + 1
  local indent_gen = self._cursor_indent_gen
  api.nvim_buf_clear_namespace(self.buf, NS_CURSOR, 0, -1)
  api.nvim_buf_clear_namespace(self.buf, NS_CURSOR_INDENT, 0, -1)
  api.nvim_set_option_value("signcolumn", "yes:1", { win = self.win })
  if not (t and t.hunk) then return end
  local indent = string.rep(" ", math.max(0, tonumber(self.hunk_indent) or 0))
  local function same(o)
    return o and o.hunk == t.hunk and o.commit == t.commit
      and o.file == t.file and o.cfile == t.cfile
  end
  for r, o in pairs(self.row_map) do
    if same(o) then
      api.nvim_buf_set_extmark(self.buf, NS_CURSOR, r, 0, {
        sign_text = "▌",
        sign_hl_group = "GleanCurrentHunk",
        priority = 100,
      })
    end
  end
  if #indent == 0 then return end
  local function apply_indent()
    if indent_gen ~= self._cursor_indent_gen or self._cursor_hunk_state ~= state
        or not api.nvim_buf_is_valid(self.buf) then return end
    for r, o in pairs(self.row_map) do
      if same(o) and not (o.line == nil and o.marker == nil and o.comment == nil) then
        api.nvim_buf_set_extmark(self.buf, NS_CURSOR_INDENT, r, 0, {
          virt_text = { { indent, "Normal" } },
          virt_text_pos = "inline",
        })
      end
    end
  end
  local delay = math.max(0, tonumber(self.hunk_indent_delay_ms) or 0)
  if delay == 0 then apply_indent() else vim.defer_fn(apply_indent, delay) end
end

-- ---------------------------------------------------------------------------
-- Sticky headers: pin the enclosing commit/file/section/hunk headers in a
-- top-anchored, non-focusable float over the glean window, the same affordance
-- treesitter-context gives for code. Driven by topline (the first visible row),
-- so it tracks <C-e>/<C-y> even with a stationary cursor. The float reuses one
-- scratch buffer and one window; later updates reposition via set_config rather
-- than recreating. Float lines are the exact header rows (prefixed with a space
-- to mirror the body's signcolumn gutter), each carrying its whole-line glean
-- highlight group.

function Session:_close_sticky_win()
  if self._sticky_win and api.nvim_win_is_valid(self._sticky_win) then
    pcall(api.nvim_win_close, self._sticky_win, true)
  end
  self._sticky_win = nil
end

function Session:close_sticky()
  self:_close_sticky_win()
  self._sticky_state = nil
end

function Session:update_sticky()
  local win = self.win
  if not (win and api.nvim_win_is_valid(win)) then
    return self:close_sticky()
  end
  -- The float is anchored to `win`; it must only exist while that window is
  -- actually displaying the glean buffer. If a different buffer was swapped in
  -- (possibly without firing this buffer's local autocmds, e.g. when the glean
  -- buffer is still visible in another split), tear the float down.
  if api.nvim_win_get_buf(win) ~= self.buf then
    return self:_close_sticky_win()
  end
  local gen = self._render_gen or 0
  local w0 = vim.fn.line("w0", win) - 1
  local width = api.nvim_win_get_width(win)
  local st = self._sticky_state
  if st and st.w0 == w0 and st.width == width and st.gen == gen then
    return
  end
  self._sticky_state = { w0 = w0, width = width, gen = gen }

  local pinned = M.compute_pinned(self.ancestry or {}, w0)
  if #pinned == 0 then
    return self:_close_sticky_win()
  end

  local sbuf = self._sticky_buf
  if not (sbuf and api.nvim_buf_is_valid(sbuf)) then
    sbuf = api.nvim_create_buf(false, true)
    self._sticky_buf = sbuf
  end
  local texts = {}
  for _, row in ipairs(pinned) do
    local line = api.nvim_buf_get_lines(self.buf, row, row + 1, false)[1] or ""
    local t = self.row_map[row]
    local f = t and not t.hunk and not t.line and self:row_file(t) or nil
    texts[#texts + 1] = M.sticky_text(line, f and f.path)
  end
  api.nvim_buf_set_lines(sbuf, 0, -1, false, texts)
  api.nvim_buf_clear_namespace(sbuf, NS_STICKY, 0, -1)
  for i, row in ipairs(pinned) do
    local hl = self.row_hl and self.row_hl[row]
    if hl then
      api.nvim_buf_set_extmark(sbuf, NS_STICKY, i - 1, 0, {
        end_row = i,
        end_col = 0,
        hl_group = hl,
        hl_eol = true,
      })
    end
  end

  local textoff = (vim.fn.getwininfo(win)[1] or {}).textoff or 0
  local cfg = {
    relative = "win",
    win = win,
    anchor = "NW",
    row = 0,
    col = textoff,
    width = math.max(1, width - textoff),
    height = #pinned,
    focusable = false,
    style = "minimal",
    zindex = 50,
  }
  if self._sticky_win and api.nvim_win_is_valid(self._sticky_win) then
    api.nvim_win_set_config(self._sticky_win, cfg)
  else
    cfg.noautocmd = true
    self._sticky_win = api.nvim_open_win(sbuf, false, cfg)
    api.nvim_set_option_value("wrap", false, { win = self._sticky_win })
  end
end

-- ---------------------------------------------------------------------------
-- The inclusive [lo, hi] row span of the hunk under `row` (the same set of rows
-- highlight_cursor_hunk paints), or nil when the row is not inside a hunk.
function Session:hunk_range(row)
  local t = self.row_map[row]
  if not (t and t.hunk) then return end
  local function same(o)
    return o and o.hunk == t.hunk and o.commit == t.commit
      and o.file == t.file and o.cfile == t.cfile
  end
  local lo, hi
  for r, o in pairs(self.row_map) do
    if same(o) then
      if not lo or r < lo then lo = r end
      if not hi or r > hi then hi = r end
    end
  end
  return lo, hi
end

-- Linewise-select the hunk under the cursor. Wired to the `ac` text object, so
-- it composes in both visual (`vac`) and operator-pending (`dac`, etc.) modes.
function Session:select_hunk_textobj()
  local lo, hi = self:hunk_range(self:cursor_row())
  if not (lo and self.win and api.nvim_win_is_valid(self.win)) then return end
  -- Drop any in-progress visual selection first; otherwise `normal! V` keeps the
  -- original anchor and the range only extends one way from the cursor.
  if api.nvim_get_mode().mode:match("[vV\22]") then
    api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
  end
  api.nvim_win_set_cursor(self.win, { lo + 1, 0 })
  vim.cmd("normal! V")
  api.nvim_win_set_cursor(self.win, { hi + 1, 0 })
end
-- Undo / redo — the buffer is a non-modifiable projection, so native undo does
-- not apply. Each user action (seen toggle, comment, collapse) is captured as a
-- small reversible action table; undo applies its reversal and moves it to the
-- redo stack, redo re-applies it. Actions are self-describing data, so the
-- stacks hold only the minimal delta, never a copy of the store.
--
--   seen:     { kind="seen", op="mark"|"unmark", groups={ {sha,path,lnums} } }
--   comment:  { kind="comment", op, path, record={anchor,content,text}, old_record? }
--   comments: { kind="comments", op="remove", records={ {path,record} } }
--   collapse: { kind="collapse", key, value, prev, obj?, field? }
-- ---------------------------------------------------------------------------

-- Mark/unmark exactly the line-identities an action names; persist the touched
-- shards. Every seen action (commit/combined toggle, visual span, marker run)
-- now carries a flat list of seen-`ids`, so this is a single fold over the
-- unified identity store with no scope- or owner-specific branching.
-- Persist a marking action. Committed identities fold through the store's range
-- API; worktree identities are stored as content block records (re-anchored
-- positionally at render), grouped per path into maximal contiguous-ordinal
-- runs so each selected block is one record.
function Session:apply_seen(a, op)
  local non_wt, wt_by_path = {}, {}
  for _, id in ipairs(a.ids) do
    if id.kind == "wt" then
      wt_by_path[id.path] = wt_by_path[id.path] or {}
      local list = wt_by_path[id.path]
      list[#list + 1] = id
    else
      non_wt[#non_wt + 1] = id
    end
  end
  local touched = {}
  if #non_wt > 0 then
    if op == "mark" then self.store:mark(non_wt) else self.store:unmark(non_wt) end
    for _, id in ipairs(non_wt) do touched[id.sha] = true end
  end
  for path, ids in pairs(wt_by_path) do
    if op == "mark" then self:apply_wt_mark(path, ids) else self:apply_wt_unmark(path, ids) end
    touched[self.store.wt_shard] = true
  end
  -- Content-addressed sticky overrides (combined scope): an explicit mark exempts
  -- the line from short-run display-demotion, and self-invalidates when its text
  -- changes. Applied even when the seen-store was a no-op (already-seen lines), so
  -- the override still sticks and re-renders.
  for _, s in ipairs(a.sticky or {}) do
    if op == "mark" then self.store:add_sticky(s.path, s.text) else self.store:remove_sticky(s.path, s.text) end
    touched[self.store.wt_shard] = true
  end
  for sha in pairs(touched) do self.store:save_commit(sha) end
end

-- Store the selected worktree lines (each carrying its flattened ordinal and
-- text) as seen-block records, one per maximal contiguous-ordinal run.
function Session:apply_wt_mark(path, ids)
  table.sort(ids, function(a, b) return (a.ord or 0) < (b.ord or 0) end)
  local run
  local function flush()
    if run then
      self.store:add_seen_record(path, { anchor = run.anchor, content = run.content })
      run = nil
    end
  end
  for _, id in ipairs(ids) do
    if run and id.ord == run.last + 1 then
      run.content[#run.content + 1] = id.text
      run.last = id.ord
    else
      flush()
      run = { anchor = id.ord, last = id.ord, content = { id.text } }
    end
  end
  flush()
end

-- Remove the selected worktree ordinals from `path`'s seen-block records,
-- re-anchoring each stored block against the live diff and rewriting it minus
-- the unmarked ordinals (splitting a partially-unmarked block into the runs that
-- survive). A fully unmarked block leaves no record, restoring byte-identity.
function Session:apply_wt_unmark(path, ids)
  local remove = {}
  for _, id in ipairs(ids) do
    if id.ord then remove[id.ord] = true end
  end
  local texts = self:wt_flat_texts(path) or {}
  local kept = {}
  for _, rec in ipairs(self.store:seen_records(path)) do
    local start = state_mod.resolve(rec.content, rec.anchor, texts)
    if not start then
      kept[#kept + 1] = { anchor = rec.anchor, content = rec.content }
    else
      local run
      local function flush()
        if run then kept[#kept + 1] = { anchor = run.anchor, content = run.content } end
        run = nil
      end
      for k = 0, #rec.content - 1 do
        local ord = start + k
        if remove[ord] then
          flush()
        elseif run and ord == run.last + 1 then
          run.content[#run.content + 1] = texts[ord]
          run.last = ord
        else
          flush()
          run = { anchor = ord, last = ord, content = { texts[ord] } }
        end
      end
      flush()
    end
  end
  self.store:set_seen_records(path, kept)
end

function Session:apply_comment(a, op)
  if op == "add" then
    self.store:add_comment_record(a.path, a.record)
  elseif op == "remove" then
    self.store:remove_comment_record(a.path, a.record)
  elseif op == "edit" then
    self.store:remove_comment_record(a.path, a.old_record)
    self.store:add_comment_record(a.path, a.record)
  elseif op == "unedit" then
    self.store:remove_comment_record(a.path, a.record)
    self.store:add_comment_record(a.path, a.old_record)
  end
  self.store:save_commit(self.store.wt_shard)
end

function Session:apply_comments(a, op)
  for _, item in ipairs(a.records) do
    if op == "remove" then
      self.store:remove_comment_record(item.path, item.record)
    else
      self.store:add_comment_record(item.path, item.record)
    end
  end
  self.store:save_commit(self.store.wt_shard)
end

-- Set a collapse key (nil clears it -> default) and mirror onto the model field
-- (commit/file/cf.raw .collapsed) when the action carries one.
function Session:apply_collapse_value(a, override, field_value)
  self.collapse[a.key] = override
  if a.obj then a.obj[a.field] = field_value end
end

function Session:apply_action(a)
  if a.kind == "seen" then
    self:apply_seen(a, a.op)
  elseif a.kind == "comment" then
    self:apply_comment(a, a.op or "add")
  elseif a.kind == "comments" then
    self:apply_comments(a, a.op)
  elseif a.kind == "collapse" then
    self:apply_collapse_value(a, a.value, a.field_value)
  end
end

function Session:reverse_action(a)
  if a.kind == "seen" then
    self:apply_seen(a, a.op == "mark" and "unmark" or "mark")
  elseif a.kind == "comment" then
    local rev = { add = "remove", remove = "add", edit = "unedit" }
    self:apply_comment(a, rev[a.op or "add"])
  elseif a.kind == "comments" then
    self:apply_comments(a, a.op == "remove" and "add" or "remove")
  elseif a.kind == "collapse" then
    self:apply_collapse_value(a, a.prev, a.prev_field_value)
  end
end

-- Apply a fresh action, push it on the undo stack, and clear the redo stack.
function Session:perform(action)
  action.cursor = self:cursor_row()
  self:apply_action(action)
  self.undo_stack[#self.undo_stack + 1] = action
  self.redo_stack = {}
end

function Session:undo()
  local a = table.remove(self.undo_stack)
  if not a then
    vim.notify("glean: nothing to undo", vim.log.levels.INFO)
    return
  end
  self:reverse_action(a)
  self.redo_stack[#self.redo_stack + 1] = a
  self:render()
  self:restore_cursor(a.cursor)
end

function Session:redo()
  local a = table.remove(self.redo_stack)
  if not a then
    vim.notify("glean: nothing to redo", vim.log.levels.INFO)
    return
  end
  self:apply_action(a)
  self.undo_stack[#self.undo_stack + 1] = a
  self:render()
end

-- ---------------------------------------------------------------------------
-- Collapse (ephemeral) — initialized from seen, then independent.
-- ---------------------------------------------------------------------------

-- Apply commit-scope collapse: an explicit user override (content-addressed in
-- self.collapse) wins; otherwise the default is "collapsed iff fully seen" so
-- only unseen work is expanded. Overrides persist across reloads/reopens.
function Session:apply_collapse()
  for _, commit in ipairs(self.commits) do
    local cov = self.collapse[commit_key(commit.sha)]
    commit.collapsed = cov ~= nil and cov or self:commit_seen(commit)
    for _, file in ipairs(commit.files) do
      local fov = self.collapse[file_key(commit.sha, file.path)]
      file.collapsed = fov ~= nil and fov or self:file_seen(commit, file)
    end
  end
end

function Session:cursor_row()
  if self.win and api.nvim_win_is_valid(self.win) then
    return api.nvim_win_get_cursor(self.win)[1] - 1
  end
  return 0
end

function Session:restore_cursor(row)
  if not (row and self.win and api.nvim_win_is_valid(self.win)) then return end
  row = math.max(0, math.min(row, api.nvim_buf_line_count(self.buf) - 1))
  pcall(api.nvim_win_set_cursor, self.win, { row + 1, 0 })
end

-- The seen/unseen section a target belongs to, or nil. Section headers carry
-- `seen`/`unseen`; hunk and diff-line rows carry `sec`. Identity is the owning
-- file (commit+file in commit scope, cfile in combined scope).
-- Only the seen section is collapsible now: unseen hunks render bare under the
-- file and fold with it, so an unseen row carries no section.
function Session:section_of(target)
  local kind
  if target.seen then kind = "seen"
  elseif target.sec == "seen" then kind = "seen"
  else return nil end
  if target.commit then
    return { commit = target.commit, file = target.file, kind = kind }
  elseif target.cfile then
    return { cfile = target.cfile, kind = kind }
  end
  return nil
end

function Session:section_key(sec)
  if sec.commit then
    local commit = self.commits[sec.commit]
    local path = commit.files[sec.file].path
    return seen_key(commit.sha, path)
  end
  return cseen_key(self.combined_files[sec.cfile].path)
end

local function same_section(a, b)
  return a and b and a.kind == b.kind and a.commit == b.commit
    and a.file == b.file and a.cfile == b.cfile
end

-- The buffer row of a section's header (the seen/unseen summary line), or nil.
function Session:section_header_row(sec)
  for r, t in pairs(self.row_map) do
    if (t.seen) and same_section(self:section_of(t), sec) then
      return r
    end
  end
  return nil
end

-- A section header (default-collapsed for seen, default-expanded for unseen)
-- toggles only its override key. Returns the action and whether it collapses.
function Session:section_action(sec)
  local key = self:section_key(sec)
  local prev = self.collapse[key]
  local cur = prev
  if cur == nil then cur = (sec.kind == "seen") end
  return {
    kind = "collapse",
    key = key,
    value = not cur,
    field_value = not cur,
    prev = prev,
    prev_field_value = nil,
  }, (not cur)
end

function Session:collapse_header_row(target)
  for r, t in pairs(self.row_map) do
    if target.marker then
      local a, b = target.marker, t.marker
      if b and not t.line and t.commit == target.commit and t.file == target.file
          and t.cfile == target.cfile and t.hunk == target.hunk
          and b.lo == a.lo and b.hi_line == a.hi_line then return r end
    elseif target.dir then
      if t.dir == target.dir and t.commit == target.commit then return r end
    elseif target.cfile then
      if t.cfile == target.cfile and not t.hunk and not t.line and not t.seen then return r end
    elseif target.file then
      if t.commit == target.commit and t.file == target.file
          and not t.hunk and not t.line and not t.seen then return r end
    elseif target.commit then
      if t.commit == target.commit and not t.file and not t.cfile and not t.dir
          and not t.hunk then return r end
    end
  end
  return nil
end

function Session:toggle_collapse(row)
  if row == nil then row = self:cursor_row() end
  local target = self.row_map[row]
  if not target then return end

  -- A marker row carries `sec` too, but it toggles only its own collapse key,
  -- not the whole section, so handle it before the section branch.
  if target.marker then
    local action = self:collapse_action(target)
    if action then self:perform(action) end
    self:render()
    if action and action.value then self:restore_cursor(self:collapse_header_row(target)) end
    return
  end

  -- Section rows (seen/unseen headers, hunks, diff lines) collapse just their
  -- section, leaving the file header in place. Collapsing parks the cursor on
  -- the header; expanding restores the row the user left off on inside it.
  local sec = self:section_of(target)
  if sec then
    self.section_offsets = self.section_offsets or {}
    local action, collapsing = self:section_action(sec)
    local key = self:section_key(sec)
    if collapsing then
      local hrow = self:section_header_row(sec) or row
      self.section_offsets[key] = row - hrow
    end
    self:perform(action)
    self:render()
    local hrow = self:section_header_row(sec)
    if hrow then
      local dst = hrow
      if not collapsing then dst = hrow + (self.section_offsets[key] or 0) end
      dst = math.max(0, math.min(dst, api.nvim_buf_line_count(self.buf) - 1))
      pcall(api.nvim_win_set_cursor, self.win, { dst + 1, 0 })
    end
    return
  end

  local action = self:collapse_action(target)
  if action then self:perform(action) end
  self:render()
  if action and action.value then self:restore_cursor(self:collapse_header_row(target)) end
end

-- Build the collapse action for `target`, or nil if the target is not
-- collapsible. A seen-section row toggles only its (default-collapsed) override
-- key; a file/commit/cfile row also mirrors the new state onto its model field
-- so the next render reflects it. prev/prev_field_value capture the exact prior
-- state so the action reverses cleanly.
function Session:collapse_action(target)
  -- key, obj/field (model mirror, optional), and the boolean the override
  -- toggles to (nil-as-collapsed default for seen sections).
  local key, obj, field, default_collapsed
  -- A marker row toggles only its content-addressed marker key (default
  -- collapsed), with no model mirror -- like the seen-section override.
  if target.dir then
    local key = (self.scope == "combined") and cdir_key(target.dir)
      or dir_key(self.commits[target.commit].sha, target.dir)
    local prev = self.collapse[key]
    return {
      kind = "collapse", key = key, value = not prev,
      field_value = not prev, prev = prev, prev_field_value = nil,
    }
  end
  if target.marker then
    local path
    if self.scope == "commits" then
      path = self.commits[target.commit].files[target.file].path
    else
      path = self.combined_files[target.cfile].path
    end
    key = (self.scope == "combined")
      and cmarker_key(path, target.marker.texts)
      or marker_key(path, target.marker.texts)
    default_collapsed = true
  elseif self.scope == "commits" then
    local commit = self.commits[target.commit]
    if target.seen then
      key, default_collapsed = seen_key(commit.sha, commit.files[target.file].path), true
    elseif target.file then
      local file = commit.files[target.file]
      key, obj, field = file_key(commit.sha, file.path), file, "collapsed"
    elseif target.commit then
      key, obj, field = commit_key(commit.sha), commit, "collapsed"
    end
  else
    if target.seen then
      key, default_collapsed = cseen_key(self.combined_files[target.cfile].path), true
    elseif target.cfile then
      local cf = self.combined_files[target.cfile]
      key, obj, field = cfile_key(cf.path), cf.raw, "collapsed"
    end
  end
  if not key then return nil end
  local prev = self.collapse[key]
  local cur = obj and obj[field]
  if cur == nil then
    cur = prev; if cur == nil then cur = default_collapsed or false end
  end
  return {
    kind = "collapse",
    key = key,
    obj = obj,
    field = field,
    value = not cur,
    field_value = not cur,
    prev = prev,
    prev_field_value = cur,
  }
end

-- ---------------------------------------------------------------------------
-- Seen marks (commit scope) — authored against (commit_sha, path, new range).
-- ---------------------------------------------------------------------------

-- Stable identity of a hunk target, surviving its relocation into the seen
-- section (the hunk index into file.hunks does not change when marked seen).
local function hunk_key(t)
  if not t then return nil end
  if t.commit then return ("c:%d:%d:%d"):format(t.commit, t.file or 0, t.hunk or 0) end
  if t.cfile then return ("f:%d:%d"):format(t.cfile, t.hunk or 0) end
  return nil
end

-- A stable key for a single diff-line row, surviving a re-render: the model
-- (commit/file or cfile) + hunk + line indices don't change when rows collapse,
-- only whether the row is rendered. Lets an action re-find "the same line" in
-- the fresh row_map after render. Nil for non-line rows (headers/markers).
local function line_anchor(t)
  if not t then return nil end
  if t.commit and t.file and t.hunk and t.line then
    return ("c:%d:%d:%d:%d"):format(t.commit, t.file, t.hunk, t.line)
  end
  if t.cfile and t.hunk and t.line then
    return ("f:%d:%d:%d"):format(t.cfile, t.hunk, t.line)
  end
  return nil
end

-- Whether two hunk targets belong to the same displayed file (commit+file in
-- the commits scope, cfile in combined).
local function same_file(a, b)
  if not (a and b) then return false end
  if a.commit then return a.commit == b.commit and a.file == b.file end
  if a.cfile then return a.cfile == b.cfile end
  return false
end

-- The seen-identities a target row addresses: every changed (add/del) line of
-- the commit (commit header), file (file header), or hunk it covers. Context
-- and unowned lines carry no identity and are excluded, so marking a unit is
-- defined purely as add/remove over these identities.
-- Walk the hunks a target addresses, handing each one's changed-line identities
-- to `fn`. Both the flat identity list (marking) and the hunk-level seen tally
-- (collapsed-row summaries) are folds over this one traversal.
function Session:each_target_hunk(target, fn)
  local function gather(file, hunks, path, owner)
    local bases = hunk_base_ords(file)
    for _, h in ipairs(hunks) do
      fn(self:changed_lines(h, path, owner, bases[h]))
    end
  end
  if self.scope == "commits" then
    local commit = self.commits[target.commit]
    if not commit then return end
    local owner = self:commit_owner(commit)
    local files = target.file and { commit.files[target.file] } or commit.files
    if target.dirfiles then
      files = {}
      for _, i in ipairs(target.dirfiles) do files[#files + 1] = commit.files[i] end
    end
    for _, file in ipairs(files) do
      gather(file, target.hunk and { file.hunks[target.hunk] } or file.hunks, file.path, owner)
    end
  elseif target.dirfiles then
    -- A directory row addresses every file beneath it; files whose ownership is
    -- still loading are inert and contribute nothing.
    for _, i in ipairs(target.dirfiles) do
      local cf = self.combined_files and self.combined_files[i]
      if cf and self:owner_status(cf.path) == "loaded" then
        gather(cf, cf.hunks, cf.path, self:combined_owner(cf.path))
      end
    end
  else
    local cf = self.combined_files and self.combined_files[target.cfile]
    if not cf then return end
    -- Backstop: ownership must be resolved before a file's identities are read.
    -- Pending hunks are inert at the UI layer, so reaching here for a non-loaded
    -- file means an invariant was violated -- fail loudly rather than degrade.
    assert(self:owner_status(cf.path) == "loaded",
      "each_target_hunk on non-loaded file: " .. cf.path)
    local owner = self:combined_owner(cf.path)
    gather(cf, target.hunk and { cf.hunks[target.hunk] } or cf.hunks, cf.path, owner)
  end
end

function Session:target_identities(target)
  local out = {}
  self:each_target_hunk(target, function(ids)
    for _, id in ipairs(ids) do out[#out + 1] = id end
  end)
  return out
end

-- Hunk-level seen tally for a collapsed row's summary. A hunk counts as seen
-- only when every one of its changed lines is; a partially marked hunk reads as
-- unseen. Hunks with no markable lines are skipped so they can't inflate either
-- side of the ratio.
function Session:hunk_summary(target)
  local seen, total = 0, 0
  self:each_target_hunk(target, function(ids)
    if #ids == 0 then return end
    total = total + 1
    if self:ids_all_seen(ids) then seen = seen + 1 end
  end)
  return seen, total
end

-- The seen collapse-section key an identity lands in: per (commit, path) in
-- commit scope, per path in combined scope -- matching emit_file_body's seen
-- section keys so marking re-collapses exactly that destination section.
function Session:seen_collapse_key(id)
  if self.scope == "commits" then
    return seen_key(id.kind == "wt" and self.store.wt_shard or id.sha, id.path)
  end
  return cseen_key(id.path)
end

-- The single identity of one literal diff-line row, or nil for a non-line row or
-- a context/unowned line. Used by the visual-range and marker actions, which act
-- on individual rows rather than whole hunks.
function Session:row_identity(target)
  if self.scope == "commits" then
    if not (target.commit and target.file and target.hunk and target.line) then return nil end
    local commit = self.commits[target.commit]
    local file = commit.files[target.file]
    return self:line_identity(file.hunks[target.hunk].lines[target.line], file.path,
      self:commit_owner(commit), target_ordinal(file, target))
  end
  if not (target.cfile and target.hunk and target.line) then return nil end
  local cf = self.combined_files[target.cfile]
  -- Backstop: pending rows are filtered before reaching here (see toggle_seen /
  -- mark_visual_range), so a non-loaded file is a violated invariant.
  assert(self:owner_status(cf.path) == "loaded",
    "row_identity on non-loaded file: " .. cf.path)
  return self:line_identity(cf.hunks[target.hunk].lines[target.line], cf.path,
    self:combined_owner(cf.path), target_ordinal(cf, target))
end

-- Toggle seen on the cursor's target. The action is decided by which section the
-- target renders in, never a symmetric toggle: `m` on a seen-section row can
-- only unmark, on an unseen-section row can only mark. A hunk row carries that
-- section in `target.sec`; a file/commit/cfile header (no section) falls back to
-- whether every addressed identity is already seen. Mark/unmark is defined
-- solely as add/remove over the target's changed-line identities; both scopes go
-- through the unified identity store, so placement and the action agree.
-- The content-addressed sticky records a target covers: one { path, text } per
-- changed (add/del) line, combined scope only (demotion is combined-only, so
-- stickiness is meaningless elsewhere). Recorded for every marked line -- even
-- already-store-seen ones -- so an explicit mark exempts the line from short-run
-- display-demotion and self-invalidates when its text later changes.
function Session:target_sticky(target)
  if self.scope ~= "combined" then return {} end
  local out = {}
  local function collect(cf, hunks)
    for _, h in ipairs(hunks) do
      for _, dl in ipairs(h.lines) do
        if dl.kind == "add" or dl.kind == "del" then
          out[#out + 1] = { path = cf.path, text = dl.text }
        end
      end
    end
  end
  if target.dirfiles then
    for _, i in ipairs(target.dirfiles) do
      local cf = self.combined_files and self.combined_files[i]
      if cf and self:owner_status(cf.path) == "loaded" then collect(cf, cf.hunks) end
    end
    return out
  end
  local cf = self.combined_files and self.combined_files[target.cfile]
  if not cf then return {} end
  collect(cf, target.hunk and { cf.hunks[target.hunk] } or cf.hunks)
  return out
end

-- The content-addressed sticky record for a single row's diff line, or nil if
-- the row is not a changed (add/del) diff line. Feeds the visual-mark path.
function Session:row_sticky(target)
  if not (target and target.cfile and target.hunk and target.line) then return nil end
  local cf = self.combined_files and self.combined_files[target.cfile]
  if not cf then return nil end
  local dl = cf.hunks[target.hunk] and cf.hunks[target.hunk].lines[target.line]
  if not dl or (dl.kind ~= "add" and dl.kind ~= "del") then return nil end
  return { path = cf.path, text = dl.text }
end

function Session:toggle_seen(row)
  if row == nil then row = self:cursor_row() end
  local target = self.row_map[row]
  if not target then return end
  -- A marker row/line unmarks its run rather than toggling the whole hunk.
  if target.marker then return self:unmark_marker(target) end
  if target.seen then return end
  -- Pending file (ownership not yet loaded): inert. Its rows expose no markable
  -- identity, so `m` is a no-op until the loader settles seen placement.
  if target.pending then return end
  if self.scope == "commits" then
    if not target.commit then return end
  elseif not target.dirfiles then
    if not target.cfile then return end
  end
  local ids = self:target_identities(target)
  local op
  if target.sec == "seen" then
    op = "unmark"
  elseif target.sec == "unseen" then
    op = "mark"
  else
    op = self:ids_all_seen(ids) and "unmark" or "mark"
  end
  local changed, seen_keys = {}, {}
  for _, id in ipairs(ids) do
    if (op == "mark") ~= self:id_seen(id) then
      changed[#changed + 1] = id
      seen_keys[self:seen_collapse_key(id)] = true
    end
  end
  local sticky = self:target_sticky(target)
  if #changed == 0 and #sticky == 0 then return end
  local action = { kind = "seen", op = op, ids = changed, sticky = sticky }
  -- Marking always re-collapses the destination seen section, even if it had been
  -- explicitly expanded: clearing the override restores the collapsed default.
  if op == "mark" then
    for k in pairs(seen_keys) do self.collapse[k] = nil end
  end
  -- Resolve the next hunk to land on *before* marking: marking relocates rows
  -- (the cursor's row number is preserved by render but its semantic target
  -- changes), so deciding afterwards skips a hunk. A hunk's identity
  -- (commit/file/cfile + hunk index) is stable across the seen-move.
  -- Marking advances to the next still-unseen hunk; unmarking lands on the next
  -- seen hunk of the same file (or the file's first unseen hunk when none remain).
  local dest_key = op == "unmark" and self:revive_dest_key(row, target) or self:next_hunk_key(row)
  self:perform(action)
  self:render()
  self:move_to_hunk_key(dest_key)
end

-- The identity of the next still-unseen hunk after `row`'s hunk, in document
-- order. Captured before a mark so the cursor can reliably land on it once the
-- just-marked hunk's rows relocate.
function Session:next_hunk_key(row)
  local cur_key = hunk_key(self.row_map[row])
  local best, best_t
  for r, t in pairs(self.row_map) do
    if t.hunk and not t.line and t.sec ~= "seen" and hunk_key(t) ~= cur_key then
      if r > row and (not best or r < best) then best, best_t = r, t end
    end
  end
  return hunk_key(best_t)
end

-- Where to land after un-marking the hunk at `row`: the next *seen* hunk of the
-- same file after it (still in the seen section), or, when none remain, the
-- first unseen hunk of that file. Captured before the mark so the cursor can
-- reliably land once the just-revived hunk's rows relocate.
function Session:revive_dest_key(row, target)
  local cur_key = hunk_key(target)
  local best, best_t
  for r, t in pairs(self.row_map) do
    if t.hunk and not t.line and t.sec == "seen" and same_file(t, target)
      and hunk_key(t) ~= cur_key and r > row and (not best or r < best) then
      best, best_t = r, t
    end
  end
  if best_t then return hunk_key(best_t) end
  best, best_t = nil, nil
  for r, t in pairs(self.row_map) do
    if t.hunk and not t.line and t.sec == "unseen" and same_file(t, target)
      and (not best or r < best) then
      best, best_t = r, t
    end
  end
  return best_t and hunk_key(best_t) or cur_key
end

-- Park the cursor on a hunk header row and scroll so as much of the hunk as
-- possible is visible: if its last row is below the viewport, scroll down until
-- the bottom shows -- but never so far that the header itself scrolls off the
-- top. Only ever scrolls down (revealing more of the hunk), never up.
function Session:move_to_hunk_row(row)
  if not (self.win and api.nvim_win_is_valid(self.win)) then return end
  pcall(api.nvim_win_set_cursor, self.win, { row + 1, 0 })
  local key = hunk_key(self.row_map[row])
  if not key then return end
  local last = row
  for r, t in pairs(self.row_map) do
    if hunk_key(t) == key and r > last then last = r end
  end
  api.nvim_win_call(self.win, function()
    local view = vim.fn.winsaveview()
    local height = api.nvim_win_get_height(self.win)
    local top = view.topline - 1
    local bottom = top + height - 1
    if last > bottom then
      local new_top = math.max(top, math.min(last - height + 1, row))
      view.topline = new_top + 1
      vim.fn.winrestview(view)
    end
  end)
end

-- Move the cursor to the rendered header row of the hunk with `key`, if any.
function Session:move_to_hunk_key(key)
  if not key then return self:move_to_next_hunk() end
  if not (self.win and api.nvim_win_is_valid(self.win)) then return end
  for r, t in pairs(self.row_map) do
    if t.hunk and not t.line and hunk_key(t) == key then
      return self:move_to_hunk_row(r)
    end
  end
  self:move_to_next_hunk()
end

-- After marking something seen its rows relocate into the (collapsed) seen
-- section, so park the cursor on the header of the next still-rendered unseen
-- hunk. Document/buffer order at or after the prior cursor row is exactly the
-- next remaining work, since render preserves the cursor's row number.
function Session:move_to_next_hunk()
  if not (self.win and api.nvim_win_is_valid(self.win)) then return end
  local cur = self:cursor_row()
  local best
  for r, t in pairs(self.row_map) do
    if t.hunk and not t.line and t.sec ~= "seen" then
      if r >= cur and (not best or r < best) then best = r end
    end
  end
  if best then self:move_to_hunk_row(best) end
end

-- Move the cursor to the nearest rendered row matching `pred` in the given
-- direction. Collapsed sections are absent from row_map, so visible navigation
-- naturally skips them.
function Session:nav_to(pred, forward)
  if not (self.win and api.nvim_win_is_valid(self.win)) then return end
  local cur = self:cursor_row()
  local best
  for r, t in pairs(self.row_map) do
    if pred(t) then
      if forward then
        if r > cur and (not best or r < best) then best = r end
      else
        if r < cur and (not best or r > best) then best = r end
      end
    end
  end
  if best then
    local t = self.row_map[best]
    if t.hunk and not t.line and not t.seen then
      self:move_to_hunk_row(best)
    else
      pcall(api.nvim_win_set_cursor, self.win, { best + 1, 0 })
    end
  end
end

local function is_hunk_row(t)
  return t.hunk and not t.line and not t.seen
end

local function is_file_row(t)
  return (t.file or t.cfile) and not t.hunk and not t.line and not t.seen
end

function Session:next_hunk() self:nav_to(is_hunk_row, true) end
function Session:prev_hunk() self:nav_to(is_hunk_row, false) end
function Session:next_file() self:nav_to(is_file_row, true) end
function Session:prev_file() self:nav_to(is_file_row, false) end

-- Mark a visual span of diff rows seen: fold each selected literal diff-line row
-- to its seen-identity (add/del; context and unowned rows carry none) and mark
-- those not already seen, so the action reverses exactly.
function Session:mark_visual_range(srow, erow)
  if srow > erow then srow, erow = erow, srow end
  local ids, sticky = {}, {}
  for row = srow, erow do
    local t = self.row_map[row]
    -- Pending rows are inert (no markable identity); skip before row_identity,
    -- whose non-loaded assertion is a backstop, not a selection filter.
    local id = t and not t.pending and self:row_identity(t)
    if id then
      if not self:id_seen(id) then ids[#ids + 1] = id end
      -- Record stickiness for every selected changed line (combined scope),
      -- even already-store-seen ones, so an explicit mark exempts it from
      -- short-run display-demotion and self-invalidates on content change.
      local rec = self.scope == "combined" and self:row_sticky(t)
      if rec then sticky[#sticky + 1] = rec end
    end
  end
  if #ids == 0 and #sticky == 0 then return end
  -- The marked span collapses into a marker on render, shifting everything below
  -- it up. Anchor on the first still-rendered diff line after the selection so
  -- the cursor stays on the same logical line rather than the same buffer row.
  local anchor
  for row = erow + 1, api.nvim_buf_line_count(self.buf) - 1 do
    anchor = line_anchor(self.row_map[row])
    if anchor then break end
  end
  self:perform({ kind = "seen", op = "mark", ids = ids, sticky = sticky })
  self:render()
  if anchor then
    for r, t in pairs(self.row_map) do
      if line_anchor(t) == anchor then
        pcall(api.nvim_win_set_cursor, self.win, { r + 1, 0 })
        break
      end
    end
  end
end

-- Unmark a marker run seen: a marker target carries {lo, hi_line} indices into
-- its hunk's lines; fold each to its seen-identity and unmark those currently
-- seen. The derived marker disappears once its lines are no longer seen.
function Session:unmark_marker(target)
  local mk = target.marker
  if not mk then return end
  local file, hunk, path, owner
  if self.scope == "commits" then
    local commit = self.commits[target.commit]
    file = commit.files[target.file]
    hunk, path, owner = file.hunks[target.hunk], file.path, self:commit_owner(commit)
  else
    file = self.combined_files[target.cfile]
    -- Markers only exist on loaded files (seen runs); a non-loaded one here is a
    -- violated invariant.
    assert(self:owner_status(file.path) == "loaded",
      "unmark_marker on non-loaded file: " .. file.path)
    hunk, path, owner = file.hunks[target.hunk], file.path, self:combined_owner(file.path)
  end
  local base = hunk_base_ords(file)[hunk]
  local ids = {}
  for li = mk.lo, mk.hi_line do
    local id = self:line_identity(hunk.lines[li], path, owner, base + li)
    if id and self:id_seen(id) then ids[#ids + 1] = id end
  end
  if #ids == 0 then return end
  self:perform({ kind = "seen", op = "unmark", ids = ids })
  self:render()
end
-- ---------------------------------------------------------------------------
-- Comments — content-addressed records { anchor, content[], text } per path,
-- re-anchored at render time (see resolve_comments / collect_comments).
-- ---------------------------------------------------------------------------

-- The single-line authoring target for a row: { path, anchor, content = {text} },
-- or nil if the row is not a literal diff line. `anchor` is the row's flattened
-- diff-line ordinal (the tiebreak / outdated fallback); `content` its text.
function Session:comment_target(row)
  local target = self.row_map[row]
  if not target or not target.line or target.pending then return nil end
  local file = self:row_file(target)
  if not file then return nil end
  local dl = file.hunks[target.hunk].lines[target.line]
  local exact = self:canonical_file(file)
  local anchor = line_ordinal(exact, dl)
  if not anchor then return nil end
  return { path = file.path, anchor = anchor, content = { dl.text } }
end

-- The visual-span authoring target: the contiguous run of literal diff-line rows
-- within one file (decoration rows excluded; capture stops at the first ordinal
-- gap), as { path, anchor, content[] }. nil if the span covers no diff rows.
function Session:visual_comment_target(srow, erow)
  local path, anchor, content, prev_ord
  for row = srow, erow do
    local t = self.row_map[row]
    if t and t.line and not t.pending then
      local file = self:row_file(t)
      if file then
        local dl = file.hunks[t.hunk].lines[t.line]
        local ord = self:canonical_ordinal(file, dl)
        if not ord then break end
        if not path then
          path, anchor, content, prev_ord = file.path, ord, { dl.text }, ord
        elseif file.path == path and ord == prev_ord + 1 then
          content[#content + 1] = dl.text
          prev_ord = ord
        else
          break
        end
      end
    end
  end
  if not path then return nil end
  return { path = path, anchor = anchor, content = content }
end

-- Add a comment record (undoable) from an authoring target + body text.
function Session:add_comment(ct, text)
  if not ct or not text or text == "" then return end
  self:perform({
    kind = "comment", op = "add", path = ct.path,
    record = { anchor = ct.anchor, content = ct.content, text = text },
  })
  self:render()
end

function Session:add_comment_at(row, text)
  if row == nil then row = self:cursor_row() end
  self:add_comment(self:comment_target(row), text)
end

-- Delete a comment attached to the cursor row's line (the line it re-anchors
-- to). With one it is removed directly; with several, the user picks. The
-- removal is an undoable "comment" action (op = "remove"), so `u` restores it.
function Session:delete_comment_at(row)
  if row == nil then row = self:cursor_row() end
  local target = self.row_map[row]
  local file = self:row_file(target)
  if not file or not target.line or target.pending then return end
  local ord = target_ordinal(file, target)
  local list = self:resolve_comments(file)[ord] or {}
  if #list == 0 then
    vim.notify("glean: no comment on this line", vim.log.levels.INFO)
    return
  end
  local function drop(c)
    if not c then return end
    self:perform({
      kind = "comment", op = "remove", path = c.path,
      record = { anchor = c.anchor, content = c.content, text = c.text },
    })
    self:render()
  end
  if #list == 1 then
    drop(list[1])
  else
    local choices = {}
    for _, c in ipairs(list) do choices[#choices + 1] = c.text end
    vim.ui.select(choices, { prompt = "glean: delete comment" }, function(_, idx)
      if idx then drop(list[idx]) end
    end)
  end
end

-- The comment identity under a cursor row, or nil. Comment rows are real,
-- cursor-addressable buffer lines (carrying { path, anchor, content, text }) so
-- `dd` and `i` can act on the comment beneath the cursor directly.
function Session:comment_under(row)
  if row == nil then row = self:cursor_row() end
  local t = self.row_map[row]
  return t and t.comment or nil
end

-- Delete the comment under the cursor (undoable). No-op off a comment row.
function Session:delete_comment_under(row)
  local c = self:comment_under(row)
  if not c then return end
  self:perform({
    kind = "comment", op = "remove", path = c.path,
    record = { anchor = c.anchor, content = c.content, text = c.text },
  })
  self:render()
end

-- Delete each distinct summary comment touched by a visual selection as one
-- undoable action. Summary location and body rows share an identity, so a
-- multi-line comment is removed only once.
function Session:delete_comments_visual_range(srow, erow)
  if srow > erow then srow, erow = erow, srow end
  local records, seen = {}, {}
  for row = srow, erow do
    local t = self.row_map[row]
    local c = t and t.summary_comment and t.comment
    if c then
      local key = c.path .. "\0" .. tostring(c.anchor) .. "\0"
        .. table.concat(c.content, "\n") .. "\0" .. c.text
      if not seen[key] then
        seen[key] = true
        records[#records + 1] = {
          path = c.path,
          record = { anchor = c.anchor, content = c.content, text = c.text },
        }
      end
    end
  end
  if #records == 0 then return end
  self:perform({ kind = "comments", op = "remove", records = records })
  self:render()
end

-- Edit the comment under the cursor in the ephemeral split, replacing its text
-- (undoable). No-op off a comment row.
function Session:edit_comment_under(row)
  local c = self:comment_under(row)
  if not c then return end
  self:open_comment_editor(vim.split(c.text, "\n", { plain = true }), function(text)
    if text == c.text then return end
    self:perform({
      kind = "comment", op = "edit", path = c.path,
      old_record = { anchor = c.anchor, content = c.content, text = c.text },
      record = { anchor = c.anchor, content = c.content, text = text },
    })
    self:render()
  end)
end

-- Open an ephemeral, multi-line comment editor in a split above the glean
-- window, seeded with `initial` lines. `:w` or `<CR>` (normal mode) submits the
-- (trimmed-of-empty) buffer text to `on_submit`; `q` or `<C-c>` cancels. The scratch buffer is
-- wiped on close so nothing persists outside the review store.
function Session:open_comment_editor(initial, on_submit)
  local ebuf = api.nvim_create_buf(false, true)
  api.nvim_set_option_value("buftype", "acwrite", { buf = ebuf })
  api.nvim_set_option_value("bufhidden", "wipe", { buf = ebuf })
  api.nvim_set_option_value("filetype", "markdown", { buf = ebuf })
  pcall(api.nvim_buf_set_name, ebuf, "glean-comment://" .. ebuf)
  local seed = (initial and #initial > 0) and initial or { "" }
  api.nvim_buf_set_lines(ebuf, 0, -1, false, seed)

  if self.win and api.nvim_win_is_valid(self.win) then
    api.nvim_set_current_win(self.win)
  end
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
  vim.cmd("startinsert")
end

-- ---------------------------------------------------------------------------
-- The first (topmost) diff file-header row for `path`, or nil. File headers
-- carry a file/cfile index with no hunk or line.
function Session:file_header_row(path)
  local best
  for r, t in pairs(self.row_map) do
    if t and (t.file or t.cfile) and not t.hunk and not t.line then
      local f = self:row_file(t)
      if f and f.path == path and (not best or r < best) then best = r end
    end
  end
  return best
end

-- The topmost inline diff row rendering comment `c` (matched by path/anchor/
-- text), excluding the bottom summary rows, or nil when it isn't displayed.
function Session:comment_row(c)
  local best
  for r, t in pairs(self.row_map) do
    local rc = t and not t.summary_comment and t.comment
    if rc and rc.path == c.path and rc.anchor == c.anchor and rc.text == c.text
        and (not best or r < best) then best = r end
  end
  return best
end

-- Expand the file (and its seen section) for every displayed copy of `path`, so
-- a re-render reveals its body. Overrides are set directly -- this is ephemeral
-- navigation, not an undoable collapse toggle.
function Session:expand_path(path)
  if self.scope == "commits" then
    for _, commit in ipairs(self.commits) do
      for _, file in ipairs(commit.files) do
        if file.path == path then
          self.collapse[commit_key(commit.sha)] = false
          self.collapse[file_key(commit.sha, path)] = false
          self.collapse[seen_key(commit.sha, path)] = false
        end
      end
    end
  else
    self.collapse[cfile_key(path)] = false
    self.collapse[cseen_key(path)] = false
  end
  -- Every enclosing directory row must be open too, or the file's rows are not
  -- emitted at all.
  local comps = vim.split(path, "/", { plain = true })
  for k = 1, #comps - 1 do
    local prefix = table.concat(comps, "/", 1, k)
    self.collapse[cdir_key(prefix)] = false
    for _, commit in ipairs(self.commits or {}) do
      self.collapse[dir_key(commit.sha, prefix)] = false
    end
  end
  self:apply_collapse()
end

-- `<CR>` on a summary file row: park the cursor on that file's header above.
function Session:reveal_summary_file(path)
  local r = self:file_header_row(path)
  if r then self:restore_cursor(r) end
  return r
end

-- `<CR>` on a summary comment row: expand the file, its seen section, and every
-- marker run hiding its line, then park the cursor on the comment in the diff
-- (falling back to the file header when the comment is outdated / not shown).
function Session:reveal_summary_comment(c)
  if not c then return end
  if c.hidden and self.ignore_whitespace then
    self._reveal_comment_after_refresh = {
      path = c.path, anchor = c.anchor, content = c.content, text = c.text,
    }
    self:set_ignore_whitespace(false)
    return
  end
  self:expand_path(c.path)
  self:render()
  local changed = false
  for _, t in pairs(self.row_map) do
    if t.marker then
      local f = self:row_file(t)
      if f and f.path == c.path then
        local a = self:collapse_action(t)
        if a and self.collapse[a.key] ~= false then
          self.collapse[a.key] = false
          changed = true
        end
      end
    end
  end
  if changed then self:render() end
  local r = self:comment_row(c) or self:file_header_row(c.path)
  if r then self:restore_cursor(r) end
  return r
end

-- Jump-to-source (Stage 5).
-- ---------------------------------------------------------------------------

-- Resolve a cursor row to the source line it points at:
--   { ref, path, lnum } where the line we review (add/context) resolves to its
--   new-file line in the post-image ref, and a deletion resolves to its old
--   line in the pre-image ref. The ref is the commit's sha (commit scope) or
--   target/base (combined scope).
function Session:jump_target(row)
  local target = self.row_map[row]
  if not target or not target.line then return nil end
  local dl, path, post_ref, pre_ref
  if self.scope == "commits" then
    if not target.commit then return nil end
    local commit = self.commits[target.commit]
    local file = commit.files[target.file]
    dl = file.hunks[target.hunk].lines[target.line]
    path = file.path
    -- The floating commit's add/context lines live in the live work tree; its
    -- pre-image (deletions) resolves against HEAD.
    if commit.sha == M.WORKTREE then
      post_ref, pre_ref = M.WORKTREE, "HEAD"
    else
      post_ref, pre_ref = commit.sha, commit.sha .. "^"
    end
  else
    if not target.cfile then return nil end
    local cf = self.combined_files[target.cfile]
    dl = cf.hunks[target.hunk].lines[target.line]
    path = cf.path
    post_ref, pre_ref = self.target, self.base
  end
  if not dl then return nil end
  if dl.kind == "del" then
    return { ref = pre_ref, path = path, lnum = dl.old_lnum or 1, is_del = true }
  end
  return { ref = post_ref, path = path, lnum = dl.new_lnum or 1 }
end

-- True when `ref` resolves to the currently checked-out HEAD commit, so the
-- working-tree file can be opened directly (LSP attaches).
function Session:ref_is_head(ref)
  local head = self.git:rev_parse("HEAD")
  if not head then return false end
  local resolved = self.git:rev_parse(ref)
  return resolved ~= nil and resolved == head
end

-- Jump to the resolved source line. Opens the live working-tree file when its
-- ref is HEAD (so LSP/navigation work), otherwise a read-only scratch buffer
-- populated from `git show ref:path`, with filetype inferred from the path.
function Session:jump(row)
  if row == nil then row = self:cursor_row() end
  local target = self.row_map[row]
  -- Summary-section rows navigate *within* the glean buffer rather than to the
  -- source file: a file row jumps to that file's header above, a comment row
  -- expands its hunk and parks the cursor on the comment in the diff.
  if target and target.summary_file then
    return self:reveal_summary_file(target.summary_file)
  end
  if target and target.summary_comment then
    return self:reveal_summary_comment(target.comment)
  end
  local jt = self:jump_target(row)
  if not jt then return end
  local win = self.win
  local abs = self.git.repo_root .. "/" .. jt.path
  -- Only post-image (add/context) rows live in the working tree; a deletion must
  -- always read its pre-image via `git show`. The floating commit's post-image
  -- ref is the live work tree directly; otherwise open live when ref is HEAD.
  local live = not jt.is_del and (jt.ref == M.WORKTREE or self:ref_is_head(jt.ref))
  if live and vim.fn.filereadable(abs) == 1 then
    if win and api.nvim_win_is_valid(win) then api.nvim_set_current_win(win) end
    vim.cmd("edit " .. vim.fn.fnameescape(abs))
    pcall(api.nvim_win_set_cursor, 0, { jt.lnum, 0 })
    return abs
  end
  -- Read-only view of the file at a specific commit, named fugitive-style with
  -- the full resolved sha so the originating commit is visible. The content is
  -- immutable, so an existing buffer with this name is reused rather than
  -- duplicated (no buffer number in the name).
  local sha = self.git:rev_parse(jt.ref) or jt.ref
  local name = "glean://" .. self.git.repo_root .. "/.git//" .. sha .. "/" .. jt.path
  local buf = vim.fn.bufnr(name)
  if buf == -1 then
    local content = self.git:show(jt.ref, jt.path) or ""
    buf = api.nvim_create_buf(false, true)
    local lines = vim.split(content, "\n", { plain = true })
    if lines[#lines] == "" then lines[#lines] = nil end
    api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    api.nvim_set_option_value("modifiable", false, { buf = buf })
    api.nvim_set_option_value("buftype", "nofile", { buf = buf })
    api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
    local ft = vim.filetype.match({ filename = jt.path, contents = lines })
    if ft then api.nvim_set_option_value("filetype", ft, { buf = buf }) end
    pcall(api.nvim_buf_set_name, buf, name)
  end
  if win and api.nvim_win_is_valid(win) then
    api.nvim_set_current_win(win)
    api.nvim_win_set_buf(win, buf)
  end
  pcall(api.nvim_win_set_cursor, 0, { jt.lnum, 0 })
  return buf
end

-- ---------------------------------------------------------------------------
-- Ephemeral split diff (fugitive-style).
-- ---------------------------------------------------------------------------

-- Create a read-only scratch buffer holding `path` at `ref`, named
-- `glean://<sha8>:<path>` so the originating commit is visible, with filetype
-- inferred from the path. Empty content (e.g. the pre-image of an added file)
-- yields an empty buffer.
local function show_buffer(git, ref, path)
  local sha = git:rev_parse(ref) or ref
  local content = git:show(ref, path) or ""
  local buf = api.nvim_create_buf(false, true)
  local lines = vim.split(content, "\n", { plain = true })
  if lines[#lines] == "" then lines[#lines] = nil end
  api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  api.nvim_set_option_value("modifiable", false, { buf = buf })
  api.nvim_set_option_value("buftype", "nofile", { buf = buf })
  api.nvim_set_option_value("bufhidden", "wipe", { buf = buf })
  local ft = vim.filetype.match({ filename = path, contents = lines })
  if ft then api.nvim_set_option_value("filetype", ft, { buf = buf }) end
  pcall(api.nvim_buf_set_name, buf, "glean://" .. sha:sub(1, 8) .. ":" .. path)
  return buf
end

-- Resolve a cursor row to the file and the two refs that bound the hunk it
-- belongs to: { path, post_ref, pre_ref, post_lnum, pre_lnum }. `post_ref` is
-- the target (post-image) version and `pre_ref` is the previous (pre-image)
-- version relative to the current commit (commit scope) or the review range
-- (combined scope).
function Session:diff_context(row)
  local target = self.row_map[row]
  if not target or not target.line then return nil end
  local dl, path, post_ref, pre_ref
  if self.scope == "commits" then
    if not target.commit then return nil end
    local commit = self.commits[target.commit]
    local file = commit.files[target.file]
    dl = file.hunks[target.hunk].lines[target.line]
    path = file.path
    if commit.sha == M.WORKTREE then
      post_ref, pre_ref = M.WORKTREE, "HEAD"
    else
      post_ref, pre_ref = commit.sha, commit.sha .. "^"
    end
  else
    if not target.cfile then return nil end
    local cf = self.combined_files[target.cfile]
    dl = cf.hunks[target.hunk].lines[target.line]
    path = cf.path
    post_ref, pre_ref = self.target, self.base
  end
  if not dl then return nil end
  return {
    path = path, post_ref = post_ref, pre_ref = pre_ref,
    post_lnum = dl.new_lnum, pre_lnum = dl.old_lnum,
  }
end

-- Open an ephemeral side-by-side diff for the file/hunk under the cursor: a
-- full-height vertical split to the right of the glean window with the hunk's
-- previous version on the left and the target version on the right, both in
-- diff mode. The target side opens the live working-tree file when it is the
-- current checkout (so LSP attaches); otherwise it is a read-only `git show`
-- buffer. The previous side is always a read-only `git show` buffer.
function Session:diffsplit(row)
  if row == nil then row = self:cursor_row() end
  local ctx = self:diff_context(row)
  if not ctx then return end
  if self.win and api.nvim_win_is_valid(self.win) then
    api.nvim_set_current_win(self.win)
  end
  vim.cmd("rightbelow vsplit")
  local right_win = api.nvim_get_current_win()
  local abs = self.git.repo_root .. "/" .. ctx.path
  local live = ctx.post_ref == M.WORKTREE or self:ref_is_head(ctx.post_ref)
  if live and vim.fn.filereadable(abs) == 1 then
    vim.cmd("edit " .. vim.fn.fnameescape(abs))
    right_win = api.nvim_get_current_win()
  else
    api.nvim_win_set_buf(right_win, show_buffer(self.git, ctx.post_ref, ctx.path))
  end
  if ctx.post_lnum then pcall(api.nvim_win_set_cursor, right_win, { ctx.post_lnum, 0 }) end
  vim.cmd("diffthis")
  vim.cmd("leftabove vsplit")
  local left_win = api.nvim_get_current_win()
  api.nvim_win_set_buf(left_win, show_buffer(self.git, ctx.pre_ref, ctx.path))
  if ctx.pre_lnum then pcall(api.nvim_win_set_cursor, left_win, { ctx.pre_lnum, 0 }) end
  vim.cmd("diffthis")
  api.nvim_set_current_win(right_win)
  return right_win, left_win
end

-- ---------------------------------------------------------------------------
-- Scope switching.
-- ---------------------------------------------------------------------------

function Session:set_scope(scope)
  if scope == self.scope then return end
  self.scope = scope
  if scope == "commits" then self:apply_collapse() end
  self:start_owner_loader()
  self:render()
end

function Session:toggle_scope()
  self:set_scope(self.scope == "commits" and "combined" or "commits")
end

-- Capture a cursor location in model coordinates before replacing the active
-- display projection. Row indices are unstable across whitespace modes, while
-- paths and Git's real old/new line numbers remain comparable.
function Session:cursor_anchor()
  if not (self.win and api.nvim_win_is_valid(self.win)) then return nil end
  local target = self.row_map[self:cursor_row()]
  local file = self:row_file(target)
  if not file then return nil end
  local anchor = { path = file.path }
  if self.scope == "commits" and target.commit then
    local commit = self.commits[target.commit]
    anchor.sha = commit and commit.sha
  end
  if target.hunk and target.line then
    local dl = file.hunks[target.hunk].lines[target.line]
    anchor.kind = dl.kind
    anchor.old_lnum = dl.old_lnum
    anchor.new_lnum = dl.new_lnum
  end
  return anchor
end

function Session:restore_cursor_anchor(anchor)
  if not (anchor and self.win and api.nvim_win_is_valid(self.win)) then return end
  local header = self:file_header_row(anchor.path)
  local best_row, best_score
  for row, target in pairs(self.row_map) do
    local file = target and target.hunk and target.line and self:row_file(target) or nil
    if file and file.path == anchor.path then
      local commit = target.commit and self.commits[target.commit] or nil
      local dl = file.hunks[target.hunk].lines[target.line]
      local score = 0
      if anchor.sha and (not commit or commit.sha ~= anchor.sha) then score = score + 1000000 end
      if anchor.kind and dl.kind ~= anchor.kind then score = score + 1 end
      local distance
      if anchor.new_lnum and dl.new_lnum then
        distance = math.abs(anchor.new_lnum - dl.new_lnum)
      elseif anchor.old_lnum and dl.old_lnum then
        distance = math.abs(anchor.old_lnum - dl.old_lnum)
      else
        local a = anchor.new_lnum or anchor.old_lnum
        local b = dl.new_lnum or dl.old_lnum
        distance = a and b and math.abs(a - b) or 10000
      end
      score = score + distance * 10
      if not best_score or score < best_score or (score == best_score and row < best_row) then
        best_row, best_score = row, score
      end
    end
  end
  self:restore_cursor(best_row or header or 0)
end

function Session:set_ignore_whitespace(enabled)
  enabled = enabled == true
  if enabled == self.ignore_whitespace then return end
  local anchor = self:cursor_anchor()
  self.ignore_whitespace = enabled
  self.undo_stack = {}
  self.redo_stack = {}
  self:refresh_model({ head = self._commit_cache_head, cursor_anchor = anchor })
end

function Session:toggle_ignore_whitespace()
  self:set_ignore_whitespace(not self.ignore_whitespace)
end

-- ---------------------------------------------------------------------------
-- Live update (work-tree target) — poll the repo and re-render in place.
-- ---------------------------------------------------------------------------

-- Rebuild the model from the current repo state and re-render, preserving the
-- content-addressed collapse overrides, the cursor, and (via immediate saves)
-- all authored seen/comments. Reloads the store from disk and clears the
-- per-target memoized caches so the projection reflects the latest content.
-- A per-file content signature of the combined diff (path -> hash of its hunk
-- geometry + line text), used by `reload` to tell which files actually changed.
-- A content-only worktree edit rewrites just the edited file's diff, so every
-- other file's rendering is still valid and can be kept.
local function combined_file_sigs(files)
  local sigs = {}
  for _, f in ipairs(files or {}) do
    local parts = {}
    for _, h in ipairs(f.hunks) do
      parts[#parts + 1] = (h.new_start or 0) .. "," .. (h.new_count or 0)
      for _, dl in ipairs(h.lines) do
        parts[#parts + 1] = (dl.kind or "") .. ":" .. (dl.text or "")
      end
    end
    sigs[f.path] = vim.fn.sha256(table.concat(parts, "\n"))
  end
  return sigs
end

-- Refresh generation: bumped whenever a refresh (reload / scope change /
-- suspend) starts, so an in-flight pipeline that has been superseded drops
-- itself in its continuation instead of painting stale data over newer. The
-- ownership loader's `_load_gen` still guards everything downstream of the
-- model landing.
function Session:bump_refresh()
  self._refresh_gen = (self._refresh_gen or 0) + 1
  return self._refresh_gen
end

-- Rebuild the model asynchronously and repaint exactly once when it lands.
-- Nothing is written to the buffer in between: the buffer shows either the
-- previous complete state or the next one, never a half-built model.
function Session:refresh_model(hints)
  if not api.nvim_buf_is_valid(self.buf) then return end
  hints = hints or {}
  local cursor_anchor = hints.cursor_anchor
  local gen = self:bump_refresh()
  build_model_async(self.git, self.base, self.target, {
    head = hints.head,
    wt_diff_text = hints.wt_diff_text,
    patch_cache = self._commit_patch_cache,
    ignore_whitespace = self.ignore_whitespace,
    from_root = self.from_root,
  }, function(files, commits, shas, meta)
    if gen ~= self._refresh_gen then return end
    if not api.nvim_buf_is_valid(self.buf) then return end
    if not files then return end
    local store = state_mod.new({ dir = self.state_dir, wt_shard = self.wt_shard })
    store:load(shas)
    self.files = files
    self.commits = commits
    self.lineage_commits = meta.lineage_commits
    self.lineage_worktree_files = meta.lineage_worktree_files
    self.canonical_files = meta.canonical_files
    self.store = store
    self._wt_lines = nil
    -- Ownership is recomposed wholesale from the patches, but the committed
    -- layers' composed state survives an unchanged commit set: only the
    -- work-tree layer is re-applied. The per-file signatures survive as the
    -- input to incremental rendering.
    self._file_sigs = combined_file_sigs(files)
    self._commit_patch_cache = meta.patch_cache
    self._commit_cache_head = meta.head
    if not meta.exact_reused then self._committed_states = nil end
    self._owner = nil
    self.combined_files = nil
    self:apply_collapse()
    self:start_owner_loader()
    self:render()
    self:restore_cursor_anchor(cursor_anchor)
    local reveal = self._reveal_comment_after_refresh
    if reveal then
      self._reveal_comment_after_refresh = nil
      self:reveal_summary_comment(reveal)
    end
  end)
end

-- A reload *is* a model refresh; the name survives for the call sites (live
-- poll, resume, tests) that mean "the repo moved, rebuild".
Session.reload = Session.refresh_model

-- Start polling the repo on a timer; only the live work-tree review opts in.
-- Each tick compares a cheap dirty signature and reloads only when it changed,
-- so an idle buffer does no rebuild work and the cursor never jumps.
-- One repo check. Compares the poll signature (HEAD + the tracked diff against
-- HEAD) and, when `opts.untracked` is set, the untracked listing too, and
-- refreshes only when something moved -- an idle buffer never repaints, so the
-- cursor never jumps. The diff text the poll already fetched is handed to the
-- refresh, so the rebuild doesn't ask git for it a second time.
--   opts.untracked — also hash the untracked listing (the slow safety net).
--   opts.baseline  — capture the signatures without refreshing.
--   opts.unchanged — called instead of a refresh when nothing moved.
function Session:poll(opts)
  opts = opts or {}
  if not self.worktree then
    if opts.unchanged then opts.unchanged() end
    return
  end
  local jobs = { poll = function(done) self.git:poll_async(done) end }
  if opts.untracked then
    jobs.untracked = function(done) self.git:untracked_sig_async(done) end
  end
  git_mod.join(jobs, function(res)
    if self._suspended or not api.nvim_buf_is_valid(self.buf) then return end
    local sig, head, diff_text = res.poll[1], res.poll[2], res.poll[3]
    local usig = res.untracked and res.untracked[1]
    local changed = sig ~= self._sig or (usig ~= nil and usig ~= self._untracked_sig)
    self._sig = sig
    if usig then self._untracked_sig = usig end
    if opts.baseline then return end
    if changed then
      self:refresh_model({ head = head, wt_diff_text = diff_text })
    elseif opts.unchanged then
      opts.unchanged()
    end
  end)
end

-- Attach the live work-tree monitoring. Refreshes are driven by editor events
-- (a save, regaining focus); the timer is only a slow safety net for changes
-- made outside the editor -- notably new untracked files, which `git diff HEAD`
-- cannot see, so the timer tick is the one that pays for the tree walk.
function Session:start_live()
  if not self.worktree or self._timer or self._suspended then return end
  self:poll({ baseline = true, untracked = true })
  self._live_group = api.nvim_create_augroup("glean_live_" .. self.buf, { clear = true })
  api.nvim_create_autocmd({ "BufWritePost", "FocusGained" }, {
    group = self._live_group,
    callback = function()
      if not api.nvim_buf_is_valid(self.buf) then return true end
      self:poll()
    end,
  })
  local timer = vim.uv.new_timer()
  self._timer = timer
  timer:start(LIVE_INTERVAL_MS, LIVE_INTERVAL_MS, function()
    vim.schedule(function()
      if not api.nvim_buf_is_valid(self.buf) then self:stop_live() return end
      self:poll({ untracked = true })
    end)
  end)
end

-- A buffer that is in no window is detached from all background work: the live
-- poll timer and any pending repaint (the ownership generation is bumped, so a
-- render still in flight drops itself on its existing guard). Nothing is
-- persisted or discarded -- the model stays put,
-- only the machinery that keeps it fresh stops.
function Session:suspend()
  if self._suspended then return end
  self._suspended = true
  self:stop_live()
  self:bump_refresh()
  self._load_gen = (self._load_gen or 0) + 1
  self._render_dirty = false
  self:close_sticky()
end

-- Re-attach. The work tree may have moved while we were hidden, so reconcile
-- against the signature captured at suspend time: reload on change, otherwise
-- just repaint.
function Session:resume()
  if not self._suspended then return end
  self._suspended = false
  self:poll({
    untracked = true,
    unchanged = function()
      self:start_owner_loader()
      self:render()
    end,
  })
  self:start_live()
end

function Session:stop_live()
  if self._timer then
  if self._live_group then
    pcall(api.nvim_del_augroup_by_id, self._live_group)
    self._live_group = nil
  end
    self._timer:stop()
    if not self._timer:is_closing() then self._timer:close() end
    self._timer = nil
  end
end

-- ---------------------------------------------------------------------------
-- Keymaps / open.
-- ---------------------------------------------------------------------------

local function show_buffer_in_window(buf)
  for _, win in ipairs(api.nvim_tabpage_list_wins(0)) do
    if api.nvim_win_get_buf(win) == buf then
      api.nvim_set_current_win(win)
      return win
    end
  end
  local is_floating = api.nvim_win_get_config(0).relative ~= ""
  if is_floating
    or vim.fn.winnr("k") ~= vim.fn.winnr()
    or vim.fn.winnr("j") ~= vim.fn.winnr()
  then
    vim.cmd("botright vsplit")
  end
  local win = api.nvim_get_current_win()
  api.nvim_win_set_buf(win, buf)
  return win
end

local function setup_keymaps(buf, session)
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  local group = api.nvim_create_augroup("glean_cursor_" .. buf, { clear = true })
  -- Keep the cursor clear of the sticky-header float (at most 4 pinned rows) so
  -- it is never occluded after jumps that land near the viewport top.
  if session.win and api.nvim_win_is_valid(session.win) then
    api.nvim_set_option_value("scrolloff", 4, { win = session.win })
  end
  api.nvim_create_autocmd("CursorMoved", {
    group = group,
    buffer = buf,
    callback = function()
      session:highlight_cursor_hunk()
      session:update_sticky()
    end,
  })
  -- Sticky headers pin to the topline, so scrolling (even with a stationary
  -- cursor) drives the update; resize repositions; leaving/closing tears down.
  api.nvim_create_autocmd("WinScrolled", {
    group = group,
    buffer = buf,
    callback = function() session:update_sticky() end,
  })
  api.nvim_create_autocmd({ "WinResized", "VimResized" }, {
    group = group,
    callback = function()
      session._sticky_state = nil
      session:update_sticky()
    end,
  })
  api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, {
    group = group,
    buffer = buf,
    callback = function() session:close_sticky() end,
  })
  -- A different buffer being displayed in the glean window (or the glean buffer
  -- being shown again) doesn't fire this buffer's Win/BufLeave (especially while
  -- the glean buffer stays visible in another split), so the float anchored to
  -- the window would otherwise linger over the swapped-in buffer. Re-evaluate on
  -- every window/buffer switch: update_sticky tears the float down when its
  -- window no longer shows the glean buffer, and rebuilds it when it returns.
  api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "WinEnter" }, {
    group = group,
    callback = function()
      session._sticky_state = nil
      session:update_sticky()
    end,
  })
  -- Closing one window showing the glean buffer (e.g. one half of a split) must
  -- not strip interactivity from the others: keymaps are buffer-local and live
  -- on, but session.win pins window-scoped behaviour (sticky float, cursor
  -- highlight, jump, q). Re-point it to another window still showing the buffer
  -- so the review keeps working; only a full buffer wipe (BufWipeout/BufDelete)
  -- tears the session down.
  api.nvim_create_autocmd("WinClosed", {
    group = group,
    callback = function(ev)
      local closed = tonumber(ev.match)
      if closed ~= session.win then return end
      session:close_sticky()
      local replacement
      for _, w in ipairs(api.nvim_list_wins()) do
        if w ~= closed and api.nvim_win_is_valid(w)
          and api.nvim_win_get_buf(w) == session.buf then
          replacement = w
          break
        end
      end
      session.win = replacement
      if replacement then
        api.nvim_set_option_value("scrolloff", 4, { win = replacement })
        session._sticky_state = nil
        vim.schedule(function() session:update_sticky() end)
      end
    end,
  })
  map("n", "=", function() session:toggle_collapse() end)
  map("n", "m", function() session:toggle_seen() end)
  map("x", "m", function()
    local srow = vim.fn.getpos("v")[2] - 1
    local erow = vim.fn.getpos(".")[2] - 1
    api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    session:mark_visual_range(srow, erow)
  end)
  map("n", "c", function()
    local ct = session:comment_target(session:cursor_row())
    if not ct then
      vim.notify("glean: cannot comment here", vim.log.levels.INFO)
      return
    end
    session:open_comment_editor({}, function(text) session:add_comment(ct, text) end)
  end)
  map("x", "c", function()
    local srow = vim.fn.getpos("v")[2] - 1
    local erow = vim.fn.getpos(".")[2] - 1
    if srow > erow then srow, erow = erow, srow end
    api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    local ct = session:visual_comment_target(srow, erow)
    if not ct then
      vim.notify("glean: cannot comment here", vim.log.levels.INFO)
      return
    end
    session:open_comment_editor({}, function(text) session:add_comment(ct, text) end)
  end)
  map("n", "i", function() session:edit_comment_under() end)
  map("n", "e", function() session:edit_comment_under() end)
  map("x", "d", function()
    local srow = vim.fn.getpos("v")[2] - 1
    local erow = vim.fn.getpos(".")[2] - 1
    api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    session:delete_comments_visual_range(srow, erow)
  end)
  map("n", "dd", function() session:delete_comment_under() end)
  map("n", "dc", function() session:delete_comment_at() end)
  map("n", "u", function() session:undo() end)
  map("n", "<C-r>", function() session:redo() end)
  map({ "x", "o" }, "ac", function() session:select_hunk_textobj() end)
  map({ "n", "x" }, "]c", function() session:next_hunk() end)
  map({ "n", "x" }, "[c", function() session:prev_hunk() end)
  map({ "n", "x" }, "]f", function() session:next_file() end)
  map({ "n", "x" }, "[f", function() session:prev_file() end)
  map("n", "<CR>", function() session:jump() end)
  map("n", "D", function() session:diffsplit() end)
  map("n", "S", function() session:toggle_scope() end)
  map("n", "W", function() session:toggle_ignore_whitespace() end)
  map("n", "q", function()
    if api.nvim_win_is_valid(session.win) then
      api.nvim_win_close(session.win, true)
    end
  end)
end

local LogView = {}
LogView.__index = LogView

function LogView:render()
  local repo = vim.fn.fnamemodify(self.git.repo_root, ":t")
  local lines = { "Glean log — " .. repo }
  local row_map = { [0] = false }
  for i, commit in ipairs(self.commits) do
    lines[#lines + 1] = commit.short_sha .. "  " .. commit.summary
    row_map[i] = i
  end
  api.nvim_set_option_value("modifiable", true, { buf = self.buf })
  api.nvim_buf_set_lines(self.buf, 0, -1, false, lines)
  api.nvim_buf_clear_namespace(self.buf, NS, 0, -1)
  api.nvim_buf_set_extmark(self.buf, NS, 0, 0, {
    end_row = 1, hl_group = "GleanModeHeader", hl_eol = true,
  })
  for row = 1, #self.commits do
    api.nvim_buf_set_extmark(self.buf, NS, row, 0, {
      end_col = #self.commits[row].short_sha, hl_group = "GleanCommitHeader",
    })
  end
  api.nvim_set_option_value("modifiable", false, { buf = self.buf })
  self.row_map = row_map
end

function LogView:open_selected(srow, erow)
  if srow > erow then srow, erow = erow, srow end
  local first, last
  for row = srow, erow do
    local index = self.row_map[row]
    if index then
      first = math.min(first or index, index)
      last = math.max(last or index, index)
    end
  end
  if not first then return end
  local newest = self.commits[first]
  local oldest = self.commits[last]
  local base = oldest.parents[1]
  local from_root = base == nil
  if from_root then
    local err
    base, err = self.git:empty_tree()
    if not base then
      vim.notify("glean: resolving the empty tree failed: " .. tostring(err), vim.log.levels.ERROR)
      return
    end
  end
  local identifier = newest.short_sha
  if first ~= last then identifier = oldest.short_sha .. ".." .. newest.short_sha end
  return M.open({
    repo_root = self.git.repo_root,
    run = self.run,
    state_dir = self.state_dir,
    open_window = self.open_window,
    base = base,
    target = newest.sha,
    identifier = identifier,
    from_root = from_root,
  })
end

local function setup_log_keymaps(buf, view)
  local function map(mode, lhs, fn)
    vim.keymap.set(mode, lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("n", "<CR>", function()
    local row = api.nvim_win_get_cursor(0)[1] - 1
    view:open_selected(row, row)
  end)
  map("x", "<CR>", function()
    local srow = vim.fn.getpos("v")[2] - 1
    local erow = vim.fn.getpos(".")[2] - 1
    api.nvim_feedkeys(api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
    view:open_selected(srow, erow)
  end)
  map("n", "q", function()
    local win = api.nvim_get_current_win()
    if api.nvim_win_get_buf(win) == buf then api.nvim_win_close(win, true) end
  end)
end

-- Open the current repository's first-parent log as a persistent, listed Glean
-- entry buffer. Reopening it refreshes the history and reuses the same buffer.
function M.open_log(opts)
  opts = opts or {}
  local repo_root = opts.repo_root or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })
  local commits, err = git:log_commits()
  if not commits then error("glean: git log failed: " .. tostring(err)) end

  local buf = log_buffers[repo_root]
  if not (buf and api.nvim_buf_is_valid(buf)) then
    buf = api.nvim_create_buf(true, false)
    api.nvim_set_option_value("buftype", "nofile", { buf = buf })
    api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
    api.nvim_set_option_value("swapfile", false, { buf = buf })
    api.nvim_set_option_value("filetype", "glean", { buf = buf })
    log_buffers[repo_root] = buf
    api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
      buffer = buf,
      callback = function()
        log_buffers[repo_root] = nil
        log_views[repo_root] = nil
      end,
    })
  end
  api.nvim_set_option_value("buflisted", true, { buf = buf })
  local repo = vim.fn.fnamemodify(repo_root, ":t")
  pcall(api.nvim_buf_set_name, buf, "Glean:" .. repo .. " log")

  local view = setmetatable({
    git = git,
    run = opts.run,
    state_dir = opts.state_dir,
    open_window = opts.open_window,
    commits = commits,
    buf = buf,
    row_map = {},
  }, LogView)
  log_views[repo_root] = view
  view:render()
  if opts.open_window ~= false then
    view.win = show_buffer_in_window(buf)
    setup_log_keymaps(buf, view)
  end
  return view
end

local PrView = {}
PrView.__index = PrView

function PrView:page_count()
  return math.max(1, math.ceil(#self.prs / self.page_size))
end

function PrView:render()
  self.page = math.max(1, math.min(self.page, self:page_count()))
  local repo = vim.fn.fnamemodify(self.git.repo_root, ":t")
  local lines = { ("Glean prs — %s — page %d/%d"):format(repo, self.page, self:page_count()) }
  local row_map = { [0] = false }
  local first = (self.page - 1) * self.page_size + 1
  local last = math.min(#self.prs, first + self.page_size - 1)
  for i = first, last do
    local pr = self.prs[i]
    local draft = pr.isDraft and " [draft]" or ""
    local author = pr.author and pr.author.login or "unknown"
    lines[#lines + 1] = ("#%d  %s  %s ← %s  %s%s"):format(
      pr.number, author, pr.baseRefName, pr.headRefName, pr.title, draft)
    row_map[#lines - 1] = i
  end
  if #self.prs == 0 then lines[#lines + 1] = "No open pull requests" end
  api.nvim_set_option_value("modifiable", true, { buf = self.buf })
  api.nvim_buf_set_lines(self.buf, 0, -1, false, lines)
  api.nvim_buf_clear_namespace(self.buf, NS, 0, -1)
  api.nvim_buf_set_extmark(self.buf, NS, 0, 0, {
    end_row = 1, hl_group = "GleanModeHeader", hl_eol = true,
  })
  for row = 1, last - first + 1 do
    local pr = self.prs[row_map[row]]
    api.nvim_buf_set_extmark(self.buf, NS, row, 0, {
      end_col = #tostring(pr.number) + 1, hl_group = "GleanCommitHeader",
    })
  end
  api.nvim_set_option_value("modifiable", false, { buf = self.buf })
  self.row_map = row_map
end

function PrView:set_page(page)
  local next_page = math.max(1, math.min(page, self:page_count()))
  if next_page == self.page then return end
  self.page = next_page
  self:render()
  if self.win and api.nvim_win_is_valid(self.win) then
    pcall(api.nvim_win_set_cursor, self.win, { math.min(2, api.nvim_buf_line_count(self.buf)), 0 })
  end
end

function PrView:open_selected(row)
  local index = self.row_map[row]
  if not index then return end
  local ok, result = pcall(M.open_pr, {
    pr = self.prs[index].number,
    repo_root = self.git.repo_root,
    run = self.run,
    gh_run = self.gh_run,
    state_dir = self.state_dir,
    open_window = self.open_window,
  })
  if ok then return result end
  local message = tostring(result)
  message = message:match("(glean: .*)") or message
  vim.notify(message, vim.log.levels.ERROR)
end

local function setup_pr_keymaps(buf, view)
  local function map(lhs, fn)
    vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("<CR>", function()
    view:open_selected(api.nvim_win_get_cursor(0)[1] - 1)
  end)
  map("]p", function() view:set_page(view.page + 1) end)
  map("[p", function() view:set_page(view.page - 1) end)
  map("q", function()
    local win = api.nvim_get_current_win()
    if api.nvim_win_get_buf(win) == buf then api.nvim_win_close(win, true) end
  end)
end

function M.open_prs(opts)
  opts = opts or {}
  local repo_root = opts.repo_root or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })
  local gh_run = opts.gh_run or function(args)
    return vim.system(args, { cwd = repo_root, text = true }):wait()
  end
  local res = gh_run({
    "gh", "pr", "list", "--state", "open", "--limit", tostring(opts.limit or 1000),
    "--json", "number,title,author,headRefName,baseRefName,isDraft",
  })
  if res.code ~= 0 then error("glean: `gh pr list` failed: " .. (res.stderr or "")) end
  local ok, prs = pcall(vim.json.decode, res.stdout)
  if not ok or type(prs) ~= "table" then error("glean: invalid `gh pr list` response") end

  local buf = pr_buffers[repo_root]
  if not (buf and api.nvim_buf_is_valid(buf)) then
    buf = api.nvim_create_buf(true, false)
    api.nvim_set_option_value("buftype", "nofile", { buf = buf })
    api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
    api.nvim_set_option_value("swapfile", false, { buf = buf })
    api.nvim_set_option_value("filetype", "glean", { buf = buf })
    pr_buffers[repo_root] = buf
    api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
      buffer = buf,
      callback = function()
        pr_buffers[repo_root] = nil
        pr_views[repo_root] = nil
      end,
    })
  end
  api.nvim_set_option_value("buflisted", true, { buf = buf })
  local repo = vim.fn.fnamemodify(repo_root, ":t")
  pcall(api.nvim_buf_set_name, buf, "Glean:" .. repo .. " prs")

  local previous = pr_views[repo_root]
  local view = setmetatable({
    git = git,
    run = opts.run,
    gh_run = gh_run,
    state_dir = opts.state_dir,
    open_window = opts.open_window,
    prs = prs,
    page_size = opts.page_size or 50,
    page = previous and previous.page or 1,
    buf = buf,
    row_map = {},
  }, PrView)
  pr_views[repo_root] = view
  view:render()
  if opts.open_window ~= false then
    view.win = show_buffer_in_window(buf)
    setup_pr_keymaps(buf, view)
  end
  return view
end

-- Open a review of `base...target`. `opts`:
--   - base, target (required): refs to diff.
--   - repo_root, run (optional): injected for tests.
--   - scope (optional, default "combined").
--   - state_dir (optional): override the ReviewStore directory (tests).
--   - storage_branch (optional): branch owning content-addressed review data.
--   - identifier (optional): invocation identifier shown in the buffer title.
--   - from_root (internal): base is the empty tree and history includes root.
--   - open_window (optional, default true).

function M.open(opts)
  assert(opts and opts.base and opts.target, "glean.open requires base and target")
  local repo_root = opts.repo_root
    or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })

  local worktree = opts.target == M.WORKTREE
  -- The model is fetched asynchronously (see the refresh pipeline below), so the
  -- session starts empty and paints once, when the model lands. Under an
  -- injected (test) runner that happens before `open` returns.
  local state_dir = opts.state_dir or M.repo_state_dir(git)
  local wt_shard = M.wt_shard(git, opts.storage_branch)
  local store = state_mod.new({ dir = state_dir, wt_shard = wt_shard })

  -- One buffer per (repo, base, target); reuse it on reopen. The live work-tree
  -- review is a "special" unlisted buffer (it tracks the current repo state and
  -- auto-refreshes); committed-range diffs are persistent and listed.
  local key = buffer_key(repo_root, opts.base, opts.target)
  local existing = buffers[key]
  local buf
  if existing and api.nvim_buf_is_valid(existing) then
    buf = existing
  else
    buf = api.nvim_create_buf(true, false)
    api.nvim_set_option_value("buftype", "nofile", { buf = buf })
    api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
    api.nvim_set_option_value("swapfile", false, { buf = buf })
    api.nvim_set_option_value("filetype", "glean", { buf = buf })
    buffers[key] = buf
    -- Background work is attached to *visibility*, not to the session's
    -- lifetime: a buffer sitting in no window must not poll the work tree or
    -- rebuild the model. Visibility is re-derived from `win_findbuf` rather than
    -- tracked per event, since BufWinLeave fires before the window is gone and
    -- one split of two closing must not detach the still-visible buffer.
    local function sync_active()
      local s = sessions[key]
      if not s then return end
      if #vim.fn.win_findbuf(buf) > 0 then s:resume() else s:suspend() end
    end
    api.nvim_create_autocmd("BufWinEnter", {
      buffer = buf,
      callback = sync_active,
    })
    api.nvim_create_autocmd({ "BufWinLeave", "BufHidden" }, {
      buffer = buf,
      callback = function() vim.schedule(sync_active) end,
    })
    api.nvim_create_autocmd("WinClosed", {
      callback = function() vim.schedule(sync_active) end,
    })
    api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
      buffer = buf,
      callback = function()
        buffers[key] = nil
        views[key] = nil
        local s = sessions[key]
        if s then
          s:stop_live()
          s:close_sticky()
        end
        sessions[key] = nil
      end,
    })
  end
  api.nvim_set_option_value("buflisted", true, { buf = buf })
  pcall(api.nvim_buf_set_name, buf, review_title(git,
    opts.identifier or range_identifier(opts.base, opts.target), opts.base, opts.target))

  -- Collapse overrides are content-addressed and kept in process memory keyed by
  -- the buffer, so neither a live reload-from-disk nor a reopen loses the user's
  -- expand/collapse choices.
  local collapse = views[key] or {}
  views[key] = collapse

  local prev = sessions[key]
  if prev then
    prev:stop_live()
    -- A superseded session can still have Git callbacks in flight. Invalidate
    -- them before the shared buffer is handed to the replacement session.
    prev:bump_refresh()
    prev._load_gen = (prev._load_gen or 0) + 1
  end

  local session = setmetatable({
    git = git,
    store = store,
    base = opts.base,
    target = opts.target,
    worktree = worktree,
    from_root = opts.from_root == true,
    ignore_whitespace = opts.ignore_whitespace == nil
      and M.config.ignore_whitespace or opts.ignore_whitespace == true,
    state_dir = state_dir,
    wt_shard = wt_shard,
    files = {},
    commits = {},
    lineage_commits = {},
    lineage_worktree_files = {},
    canonical_files = {},
    -- Baselines so the first content-only reload after open is already
    -- incremental (reuses the cached committed lineage) rather than re-walking
    -- the log once before the incremental path can engage.
    _file_sigs = {},
    scope = opts.scope or "combined",
    min_seen_run = opts.min_seen_run or M.config.min_seen_run,
    hunk_indent = opts.hunk_indent or M.config.hunk_indent,
    hunk_indent_delay_ms = opts.hunk_indent_delay_ms or M.config.hunk_indent_delay_ms,
    buf = buf,
    win = nil,
    row_map = {},
    collapse = collapse,
    undo_stack = {},
    redo_stack = {},
  }, Session)
  sessions[key] = session
  session:apply_collapse()

  local open_window = opts.open_window ~= false
  if open_window then
    session.win = show_buffer_in_window(buf)
    setup_keymaps(buf, session)
    session:start_live()
  end

  session:refresh_model()
  return session
end

-- Resolve the base/target for "current branch + dirty", with the live work tree
-- (the floating commit) as the target. On a feature branch the base is the fork
-- point from the default trunk (merge-base), so the review shows commits unique
-- to the branch plus uncommitted edits. On the default branch itself there is no
-- meaningful fork point, so the base is the upstream tracking ref (e.g.
-- origin/main), yielding unpushed commits plus uncommitted edits.
function M.resolve_dirty(git)
  -- Detect the repo's trunk from origin/HEAD (e.g. origin/dev, origin/main) so
  -- we don't assume a "main" branch; fall back to the configured default_base.
  local trunk = git:default_trunk() or M.config.default_base
  local trunk_branch = trunk:gsub("^[^/]+/", "")
  local base
  if git:current_branch() == trunk_branch then
    base = git:upstream()
  else
    base = git:merge_base(trunk, "HEAD")
  end
  return base or trunk, M.WORKTREE
end

-- Open a review of "current branch + dirty". An explicit `opts.base` overrides
-- the resolved fork-point/upstream base; the target is always the work tree.
function M.open_dirty(opts)
  opts = opts or {}
  local repo_root = opts.repo_root
    or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })
  local base, target = M.resolve_dirty(git)
  local review_base = opts.base or base
  local identifier = opts.identifier
    or (opts.base and opts.base or git:current_branch() or range_identifier(review_base, target))
  return M.open(vim.tbl_extend("force", opts, {
    repo_root = repo_root, base = review_base, target = target,
    identifier = identifier,
  }))
end
local function github_pr_repo(url)
  if type(url) ~= "string" then return nil end
  local owner, repo = url:match("^https?://github%.com/([^/]+)/([^/]+)/pull/%d+")
  if not owner then return nil end
  return (owner .. "/" .. repo):lower()
end

local function github_remote_repo(url)
  if not url then return nil end
  local owner, repo = url:match("^https?://github%.com/([^/]+)/([^/]+)")
  if not owner then owner, repo = url:match("^git@github%.com:([^/]+)/([^/]+)") end
  if not owner then owner, repo = url:match("^ssh://git@github%.com/([^/]+)/([^/]+)") end
  if not owner then return nil end
  repo = repo:gsub("/+$", ""):gsub("%.git$", "")
  return (owner .. "/" .. repo):lower()
end

-- Resolve the base/target refs for a GitHub PR via the `gh` CLI, fetching the
-- PR's head (and base) commits into the local object store first so the range
-- can be diffed without changing the checkout. `pr` is the PR number, or nil to
-- use the PR associated with the current branch. `gh_run` is an injectable
-- command runner (for tests). Returns base, target as concrete oids, suitable
-- for the three-dot `base...target` review combined diff, plus the PR head
-- branch used to associate content-addressed review storage and the PR number.
function M.resolve_pr(git, pr, gh_run)
  local pr_repo = github_pr_repo(pr)
  if pr_repo then
    local origin_repo = github_remote_repo(git:remote_url("origin"))
    if pr_repo ~= origin_repo then
      error(("glean: PR repository %s does not match origin%s"):format(
        pr_repo, origin_repo and (" " .. origin_repo) or ""))
    end
  end
  gh_run = gh_run or function(args)
    return vim.system(args, { cwd = git.repo_root, text = true }):wait()
  end
  local gh_args = { "gh", "pr", "view" }
  if pr then gh_args[#gh_args + 1] = tostring(pr) end
  vim.list_extend(gh_args, {
    "--json", "number,baseRefName,headRefName,headRefOid,baseRefOid",
  })
  local res = gh_run(gh_args)
  if res.code ~= 0 then
    error("glean: `gh pr view` failed: " .. (res.stderr or ""))
  end
  local info = vim.json.decode(res.stdout)
  -- Pull the PR head (and base) into the object store. Nothing local is moved.
  local ok, err = git:fetch("origin", "pull/" .. info.number .. "/head")
  if not ok then error("glean: fetching PR head failed: " .. tostring(err)) end
  local base_ok, base_err = git:fetch("origin", info.baseRefName)
  if not base_ok then error("glean: fetching PR base failed: " .. tostring(base_err)) end
  return info.baseRefOid, info.headRefOid, info.headRefName, info.number
end

-- Open a glean review of a GitHub PR. `opts.pr` is the PR number (defaults to
-- the PR for the current branch). The PR's commits are fetched locally first;
-- the checkout and working tree are left untouched.
function M.open_pr(opts)
  opts = opts or {}
  local repo_root = opts.repo_root
    or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })
  local base, target, branch, number = M.resolve_pr(git, opts.pr, opts.gh_run)
  return M.open(vim.tbl_extend("force", opts, {
    repo_root = repo_root, base = base, target = target,
    storage_branch = branch,
    identifier = opts.identifier or "PR #" .. number,
  }))
end

-- Resolve the base/target refs for reviewing a branch against its trunk: the
-- base is the fork point (merge-base of the repo's trunk and the branch) and the
-- target is the branch tip, so the review shows exactly what the branch adds.
-- Returns base, target.
function M.resolve_branch(git, branch)
  local trunk = git:default_trunk() or M.config.default_base
  -- Refresh the branch and trunk from origin (best-effort: a local-only branch
  -- or offline remote shouldn't fail the review) so the fork point and tip are
  -- current. Nothing local is moved; only the object store is updated.
  git:fetch("origin", branch)
  git:fetch("origin", (trunk:gsub("^[^/]+/", "")))
  -- Prefer the remote tracking ref so the review reflects what's on origin;
  -- fall back to the local branch when there is no remote copy.
  local target = branch
  if git:rev_parse("origin/" .. branch) then
    target = "origin/" .. branch
  end
  local base = git:merge_base(trunk, target)
  return base or trunk, target
end

-- Open a glean review of a branch against its trunk fork-point. `opts.branch` is
-- the branch name (or any ref). The checkout and working tree are untouched.
function M.open_branch(opts)
  opts = opts or {}
  assert(opts.branch and opts.branch ~= "", "glean: open_branch requires a branch")
  local repo_root = opts.repo_root
    or resolve_repo_root(api.nvim_buf_get_name(0))
  assert(repo_root, "glean: could not find a git repo root")
  local git = git_mod.new({ repo_root = repo_root, run = opts.run })
  local base, target = M.resolve_branch(git, opts.branch)
  return M.open(vim.tbl_extend("force", opts, {
    repo_root = repo_root, base = base, target = target,
    storage_branch = opts.branch,
    identifier = opts.identifier or opts.branch,
  }))
end

-- A foreground-only spec carrying just the visible attributes of `src` (its
-- foreground color + emphasis), dropping its background. Used for aligned diff
-- lines, whose background moves to the changed spans only.
local function fg_only(src)
  local hl = api.nvim_get_hl(0, { name = src, link = false })
  return { fg = hl.fg, bold = hl.bold, italic = hl.italic }
end

-- Highlight groups are (re)applied here and on every ColorScheme, because the
-- foreground-only GleanAddText/GleanDelText are derived from the resolved
-- DiffAdd/DiffDelete colors rather than a static link.
local function setup_highlights()
  api.nvim_set_hl(0, "GleanFileHeader", { link = "Title", default = true })
  api.nvim_set_hl(0, "GleanCommitHeader", { link = "Title", default = true })
  api.nvim_set_hl(0, "GleanHunkHeader", { link = "Comment", default = true })
  api.nvim_set_hl(0, "GleanAdd", { link = "DiffAdd", default = true })
  api.nvim_set_hl(0, "GleanDel", { link = "DiffDelete", default = true })
  -- Emphasis on a changed span uses the full diff background (green/red).
  api.nvim_set_hl(0, "GleanAddEmph", { link = "DiffAdd", default = true })
  api.nvim_set_hl(0, "GleanDelEmph", { link = "DiffDelete", default = true })
  -- The body of an aligned line: just colored text, no background.
  api.nvim_set_hl(0, "GleanAddText", fg_only("DiffAdd"))
  api.nvim_set_hl(0, "GleanDelText", fg_only("DiffDelete"))
  api.nvim_set_hl(0, "GleanContext", { link = "Normal", default = true })
  api.nvim_set_hl(0, "GleanSeen", { link = "NonText", default = true })
  api.nvim_set_hl(0, "GleanComment", { link = "WarningMsg", default = true })
  api.nvim_set_hl(0, "GleanModeHeader", { link = "Title", default = true })
  -- The "--- unseen ---" divider is meant to pop, not blend in.
  api.nvim_set_hl(0, "GleanDivider", { link = "Todo", default = true })
  api.nvim_set_hl(0, "GleanCurrentHunk", { link = "Identifier", default = true })
end

local function open_pr_notified(pr)
  local ok, result = pcall(M.open_pr, { pr = pr })
  if ok then return result end
  local message = tostring(result)
  message = message:match("(glean: .*)") or message
  vim.notify(message, vim.log.levels.ERROR)
end

local function is_pr_arg(arg)
  if not arg then return false end
  return arg:match("^%d+$") ~= nil
    or arg:match("^https?://github%.com/[^/]+/[^/]+/pull/%d+[/#?]?.*$") ~= nil
end

function M.setup(opts)
  M.config = vim.tbl_extend("force", M.config, opts or {})
  setup_highlights()
  api.nvim_create_autocmd("ColorScheme", {
    group = api.nvim_create_augroup("GleanHighlights", { clear = true }),
    callback = setup_highlights,
  })
  api.nvim_create_user_command("Glean", function(o)
    local args = o.fargs
    if args[1] == "log" then
      M.open_log()
      return
    end
    if args[1] == "prs" then
      M.open_prs()
      return
    end
    if args[1] == "pr" then
      open_pr_notified(args[2])
      return
    end
    if args[1] == "branch" then
      M.open_branch({ branch = args[2] })
      return
    end
    if #args == 0 then
      M.open_dirty()
      return
    end
    if #args == 1 then
      if is_pr_arg(args[1]) then
        open_pr_notified(args[1])
      else
        M.open_dirty({ base = args[1] })
      end
      return
    end
    M.open({ base = args[1], target = args[2] })
  end, { nargs = "*" })
end

-- Internal helpers exposed for unit tests only.
M._internal = {
  dir_layout = dir_layout,
  hunk_marker_runs = hunk_marker_runs,
  display_seen_map = display_seen_map,
  marker_key = marker_key,
  cmarker_key = cmarker_key,
  is_pr_arg = is_pr_arg,
  github_pr_repo = github_pr_repo,
  github_remote_repo = github_remote_repo,
  open_pr_notified = open_pr_notified,
}

return M
