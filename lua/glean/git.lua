-- glean.git: git plumbing for glean.
--
-- All invocations are read-only and scoped to an explicit `repo_root`. The
-- module is constructed via `git.new(opts)` so tests can inject a custom runner
-- (e.g. to stub git or point at a throwaway repo) and never rely on cwd.
local diff = require("glean.diff")

local M = {}

-- Discover the repo root for a buffer path by walking upward for `.git`,
-- mirroring shuck's search-root discovery. Returns nil if none is found.
function M.discover_repo_root(path)
  local start = path
  if not start or start == "" then start = vim.fn.getcwd() end
  if vim.fn.isdirectory(start) == 0 then start = vim.fs.dirname(start) end
  local found = vim.fs.find(".git", { upward = true, path = start })
  if found and #found > 0 then return vim.fs.dirname(found[1]) end
  return nil
end

-- `abs` expressed relative to `repo_root`, or nil when it lies outside. Symlink
-- differences between the two (macOS `/var` vs `/private/var`) are reconciled by
-- retrying against fully resolved paths.
function M.relpath(repo_root, abs)
  if not repo_root or not abs or abs == "" then return nil end
  local function under(root, path)
    if path:sub(1, #root + 1) ~= root .. "/" then return nil end
    return path:sub(#root + 2)
  end
  local root = vim.fs.normalize(repo_root)
  local path = vim.fs.normalize(abs)
  return under(root, path)
    or under(vim.fs.normalize(vim.fn.resolve(repo_root)), vim.fs.normalize(vim.fn.resolve(abs)))
end

local Git = {}
Git.__index = Git

-- Create a git handle. `opts`:
--   - repo_root (required): cwd for all git calls.
--   - run (optional): function(args) -> { code, stdout, stderr } used to run
--     git. Defaults to a synchronous `vim.system` runner. Injectable for tests.
function M.new(opts)
  assert(opts and opts.repo_root, "glean.git.new requires repo_root")
  local self = setmetatable({}, Git)
  self.repo_root = opts.repo_root
  self._run = opts.run
  return self
end

-- Run git with the given argument list (not including the leading "git").
-- Returns stdout on success, or nil + stderr on failure.
function Git:run(args)
  if self._run then
    local res = self._run(args)
    if res.code ~= 0 then return nil, res.stderr or "" end
    return res.stdout or ""
  end
  -- Pin diff path-prefix config so paths are always `a/`/`b/` regardless of the
  -- user's git config (e.g. `diff.mnemonicPrefix`/`diff.noprefix`), which the
  -- diff parser's prefix stripping assumes.
  local cmd = { "git", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = self.repo_root, text = true }):wait()
  if res.code ~= 0 then return nil, res.stderr or "" end
  return res.stdout or ""
end

-- Async counterpart to `run`: invoke `cb(stdout_or_nil, err)` when the git call
-- completes. Under an injected runner (tests) this calls it and invokes `cb`
-- synchronously for deterministic, process-free behavior; otherwise it spawns
-- `vim.system` without `:wait()` and schedules `cb` on the main loop. The
-- callback signature mirrors `run`: stdout string on success, or nil + stderr.
function Git:run_async(args, cb)
  if self._run then
    local res = self._run(args)
    if res.code ~= 0 then
      cb(nil, res.stderr or "")
    else
      cb(res.stdout or "")
    end
    return
  end
  local cmd = { "git", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  vim.system(cmd, { cwd = self.repo_root, text = true }, function(res)
    vim.schedule(function()
      if res.code ~= 0 then
        cb(nil, res.stderr or "")
      else
        cb(res.stdout or "")
      end
    end)
  end)
end

-- Fan out independent async queries and invoke `cb(results)` once every one has
-- landed. `jobs` maps a name to a function taking a `done(...)` callback; the
-- results table maps the same names to the packed callback arguments. Every job
-- is started before any completion is processed (that is the point: the queries
-- are independent, so they go out together rather than chaining), and the
-- pending count is fixed up front so a runner that completes synchronously
-- (tests) drains deterministically inside this call.
function M.join(jobs, cb)
  local names = {}
  for name in pairs(jobs) do names[#names + 1] = name end
  table.sort(names)
  local results = {}
  local pending = #names
  if pending == 0 then return cb(results) end
  for _, name in ipairs(names) do
    jobs[name](function(...)
      results[name] = { n = select("#", ...), ... }
      pending = pending - 1
      if pending == 0 then cb(results) end
    end)
  end
end

-- Resolve a ref to a concrete 40-char sha. Returns nil on failure.
function Git:rev_parse(ref)
  local out, err = self:run({ "rev-parse", ref })
  if not out then return nil, err end
  return (out:gsub("%s+$", ""))
end

-- The configured URL for a remote, or nil when the remote does not exist.
function Git:remote_url(remote)
  local out = self:run({ "remote", "get-url", remote })
  if not out then return nil end
  out = out:gsub("%s+$", "")
  if out == "" then return nil end
  return out
end

-- The current branch name (`HEAD` when detached). Used for buffer labels.
function Git:current_branch()
  local out = self:run({ "rev-parse", "--abbrev-ref", "HEAD" })
  if not out then return nil end
  return (out:gsub("%s+$", ""))
end

-- First-parent history from HEAD, newest first. Parent ids are included so a
-- selected log row can be opened as the exact commit range against its oldest
-- commit's first parent. Returns { sha, short_sha, summary, parents } entries.
-- `opts.limit` / `opts.skip` page the history so opening the log on a large
-- repo only costs the first screenful.
function Git:log_commits(opts)
  opts = opts or {}
  local args = {
    "log", "--first-parent", "--no-color", "--abbrev=8",
    "--format=%x00%H%x09%h%x09%P%x09%s",
  }
  if opts.skip and opts.skip > 0 then args[#args + 1] = "--skip=" .. opts.skip end
  if opts.limit then args[#args + 1] = "-n" .. opts.limit end
  local out, err = self:run(args)
  if not out then return nil, err end
  local commits = {}
  for chunk in out:gmatch("%z([^%z]*)") do
    chunk = chunk:gsub("\n$", "")
    local sha, short_sha, parents, summary = chunk:match("^(%x+)\t(%x+)\t([^\t]*)\t(.*)$")
    if sha then
      local parsed_parents = {}
      for parent in parents:gmatch("%x+") do parsed_parents[#parsed_parents + 1] = parent end
      commits[#commits + 1] = {
        sha = sha,
        short_sha = short_sha,
        summary = summary,
        parents = parsed_parents,
      }
    end
  end
  return commits
end

-- The repository's shared git directory (`git rev-parse --git-common-dir`),
-- resolved to an absolute path. Every linked worktree of a repo points at the
-- same common dir, so this is a stable per-repo identity (whereas `--git-dir`
-- differs per worktree). git may return a relative path (e.g. `.git`); we
-- anchor it under `repo_root` and normalize. Returns nil on failure.
function Git:common_dir()
  local out = self:run({ "rev-parse", "--git-common-dir" })
  if not out then return nil end
  out = out:gsub("%s+$", "")
  if out == "" then return nil end
  if out:sub(1, 1) ~= "/" then
    out = self.repo_root .. "/" .. out
  end
  return (vim.fn.resolve(vim.fn.fnamemodify(out, ":p")):gsub("/$", ""))
end

-- The upstream tracking ref for `ref` (default HEAD), e.g. `origin/main`.
-- Returns the ref name, or nil when no upstream is configured.
function Git:upstream(ref)
  local out = self:run({ "rev-parse", "--abbrev-ref", "--symbolic-full-name",
    (ref or "HEAD") .. "@{upstream}" })
  if not out then return nil end
  out = out:gsub("%s+$", "")
  if out == "" then return nil end
  return out
end

-- The repository's default branch (trunk), detected from the remote HEAD
-- symbolic ref (e.g. `origin/dev` for aurelia, `origin/main` for infra).
-- Returns the short ref like `origin/dev`, or nil when it can't be resolved
-- (e.g. `origin/HEAD` not set). Used so reviews don't assume a `main` trunk.
function Git:default_trunk()
  local out = self:run({ "symbolic-ref", "--short", "refs/remotes/origin/HEAD" })
  if not out then return nil end
  out = out:gsub("%s+$", "")
  if out == "" then return nil end
  return out
end

-- Diff-producing APIs take a boolean whitespace mode. Keep option assembly in
-- one place so exact calls remain unchanged and optional flags always precede
-- refs and pathspec separators.
local function append_diff_options(args, ignore_whitespace)
  if ignore_whitespace then args[#args + 1] = "--ignore-all-space" end
  return args
end

-- The first-parent commits of `base..target`, oldest first, each with its own
-- patch against its first parent. One `git log -p` process answers three
-- questions at once: the commit list, every commit's diff, and the input to
-- lineage composition.
--
-- `-U0` makes every hunk a single contiguous change block; `-M` reports renames
-- as one entry; `--format=%x00%H%x09%s` prefixes each commit with a NUL
-- sentinel we split on (git never emits binary content in a text diff, so NUL
-- cannot occur inside a patch). Returns a list of { sha, summary, files }.
local LOG_PATCH_ARGS = {
  "log", "--first-parent", "--reverse", "-p", "-U0", "-M", "--no-color",
  "--format=%x00%H%x09%s",
}

local function log_patch_root_args(target, ignore_whitespace)
  local args = {}
  for _, a in ipairs(LOG_PATCH_ARGS) do args[#args + 1] = a end
  append_diff_options(args, ignore_whitespace)
  args[#args + 1] = "--root"
  args[#args + 1] = target
  return args
end

local function log_patch_args(base, target, ignore_whitespace)
  local args = {}
  for _, a in ipairs(LOG_PATCH_ARGS) do args[#args + 1] = a end
  append_diff_options(args, ignore_whitespace)
  args[#args + 1] = base .. ".." .. target
  return args
end

local function parse_log_patches(out)
  local patches = {}
  for chunk in out:gmatch("%z([^%z]*)") do
    local sha, summary, rest = chunk:match("^(%x+)\t([^\n]*)\n?(.*)$")
    if sha then
      patches[#patches + 1] = { sha = sha, summary = summary, files = diff.parse(rest or "") }
    end
  end
  return patches
end

function Git:log_patches(base, target, ignore_whitespace)
  local out, err = self:run(log_patch_args(base, target, ignore_whitespace))
  if not out then return nil, err end
  return parse_log_patches(out)
end

-- Async counterpart to `log_patches`: `cb(patches_or_nil, err)`.
function Git:log_patches_async(base, target, ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  self:run_async(log_patch_args(base, target, ignore_whitespace), function(out, err)
    if not out then return cb(nil, err) end
    cb(parse_log_patches(out))
  end)
end

-- First-parent patches from the root commit through `target`, oldest first.
function Git:log_patches_from_root_async(target, ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  self:run_async(log_patch_root_args(target, ignore_whitespace), function(out, err)
    if not out then return cb(nil, err) end
    cb(parse_log_patches(out))
  end)
end

-- The repository's object-format-specific empty tree id. Used as the pre-image
-- when a log selection includes the root commit.
function Git:empty_tree()
  local path = vim.fn.tempname()
  vim.fn.writefile({}, path)
  local out, err = self:run({ "hash-object", "-t", "tree", path })
  vim.fn.delete(path)
  if not out then return nil, err end
  return (out:gsub("%s+$", ""))
end


-- Parsed diff of the working tree against HEAD (`git diff HEAD`: staged +
-- unstaged tracked changes). This is the floating commit's tracked-file content.
-- Returns a list of FileEntries.
function Git:worktree_diff(path, ignore_whitespace)
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = "HEAD"
  if path then args[#args + 1] = "--"; args[#args + 1] = path end
  local out, err = self:run(args)
  if not out then return nil, err end
  return diff.parse(out)
end

-- Parsed diff from `base` to the working tree (two-dot `git diff <base>`):
-- everything that changed since `base`, committed and uncommitted. Used as the
-- combined-scope net diff when the review target is the work tree. Returns a
-- list of FileEntries.
function Git:diff_to_worktree(base, path, ignore_whitespace)
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = base
  if path then args[#args + 1] = "--"; args[#args + 1] = path end
  local out, err = self:run(args)
  if not out then return nil, err end
  return diff.parse(out)
end

-- Async counterparts to the parsed-diff queries. Each mirrors its sync form's
-- signature with a trailing `cb(files_or_nil, err)`, so the refresh pipeline can
-- fan them out through `M.join` instead of blocking the UI thread.
local function parse_cb(cb)
  return function(out, err)
    if not out then return cb(nil, err) end
    cb(diff.parse(out))
  end
end

function Git:worktree_diff_async(ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = "HEAD"
  self:run_async(args, parse_cb(cb))
end

function Git:diff_to_worktree_async(base, ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = base
  self:run_async(args, parse_cb(cb))
end

function Git:diff_async(base, target, ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = base
  args[#args + 1] = target
  self:run_async(args, parse_cb(cb))
end

function Git:combined_diff_async(base, target, ignore_whitespace, cb)
  if type(ignore_whitespace) == "function" then
    cb, ignore_whitespace = ignore_whitespace, false
  end
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = base .. "..." .. target
  self:run_async(args, parse_cb(cb))
end

-- Resolve the merge base (fork point) of two refs (`git merge-base a b`).
-- Returns the sha, or nil + stderr on failure.
function Git:merge_base(a, b)
  local out, err = self:run({ "merge-base", a, b })
  if not out then return nil, err end
  return (out:gsub("%s+$", ""))
end

-- Untracked, non-ignored files synthesized as all-addition FileEntries so they
-- attach to the floating commit alongside tracked dirty edits. Read-only: we
-- never `git add -N`. Each entry has kind "add" and a single hunk whose lines
-- are the working file's lines, each an `add` with new_lnum = 1..N (no old_lnum,
-- no deletions). Binary or unreadable files are skipped.
local function untracked_args(path)
  local args = { "ls-files", "--others", "--exclude-standard", "-z" }
  if path then args[#args + 1] = "--"; args[#args + 1] = path end
  return args
end

function Git:parse_untracked(out)
  local files = {}
  for p in out:gmatch("([^%z]+)") do
    local full = self.repo_root .. "/" .. p
    local ok, lines = pcall(vim.fn.readfile, full)
    local binary = false
    if ok and lines then
      for _, l in ipairs(lines) do
        if l:find("\0", 1, true) then binary = true; break end
      end
    end
    if ok and lines and not binary then
      local dlines = {}
      for i, text in ipairs(lines) do
        dlines[#dlines + 1] = { kind = "add", text = text, new_lnum = i }
      end
      local n = #lines
      files[#files + 1] = {
        path = p,
        old_path = p,
        kind = "add",
        hunks = (n > 0) and { {
          old_start = 0,
          old_count = 0,
          new_start = 1,
          new_count = n,
          header = ("@@ -0,0 +1,%d @@"):format(n),
          lines = dlines,
        } } or {},
      }
    end
  end
  return files
end

function Git:untracked(path)
  local out, err = self:run(untracked_args(path))
  if not out then return nil, err end
  return self:parse_untracked(out)
end

-- Async counterpart to `untracked`: `cb(files_or_nil, err)`.
function Git:untracked_async(path, cb)
  self:run_async(untracked_args(path), function(out, err)
    if not out then return cb(nil, err) end
    cb(self:parse_untracked(out))
  end)
end

-- Parsed net diff `base...target` (three-dot: changes on target since it
-- diverged from base — "what's in the branch that isn't in main"). Returns a
-- list of FileEntries.
function Git:combined_diff(base, target, path, ignore_whitespace)
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = base .. "..." .. target
  if path then args[#args + 1] = "--"; args[#args + 1] = path end
  local out, err = self:run(args)
  if not out then return nil, err end
  return diff.parse(out)
end

-- Parsed diff over an arbitrary range `from..to` for a single path. Used for
-- the tighter `Xe^..TARGET` follow-up re-diff in later stages.
function Git:range_diff(from, to, path, ignore_whitespace)
  local args = append_diff_options({ "diff", "--no-color" }, ignore_whitespace)
  args[#args + 1] = from .. ".." .. to
  if path then args[#args + 1] = "--"; args[#args + 1] = path end
  local out, err = self:run(args)
  if not out then return nil, err end
  return diff.parse(out)
end



-- The poll signature: HEAD plus the tracked diff against HEAD. Cheap (no
-- whole-tree stat) and it is the same text the refresh needs, so the poll hands
-- it on rather than making the rebuild ask git for it again -- one subprocess
-- less per tick and no TOCTOU window between the two calls.
-- `cb(sig, head, diff_text)`.
function Git:poll_async(cb)
  M.join({
    head = function(done) self:run_async({ "rev-parse", "HEAD" }, done) end,
    diff = function(done) self:run_async({ "diff", "--no-color", "HEAD" }, done) end,
  }, function(res)
    local head = (res.head[1] or ""):gsub("%s+$", "")
    local diff_out = res.diff[1] or ""
    cb(vim.fn.sha256(head .. "\0" .. diff_out), head, diff_out)
  end)
end

-- A signature over the untracked file listing. `git diff HEAD` cannot see
-- untracked files, so this is the only thing the poll signature misses; it is a
-- whole-tree walk, so only the slow safety-net tick pays for it.
function Git:untracked_sig_async(cb)
  self:run_async(untracked_args(), function(out)
    cb(vim.fn.sha256(out or ""))
  end)
end

-- Fetch objects for a refspec from a remote into the object store, without
-- updating any local branch or touching the working tree / checkout. Used to
-- make a PR's commits available locally before reviewing them. Returns true on
-- success, or nil + stderr.
function Git:fetch(remote, refspec)
  local out, err = self:run({ "fetch", remote, refspec })
  if not out then return nil, err end
  return true
end

-- Contents of a path at a ref (`git show REF:path`). Used by jump-to-source.
function Git:show(ref, path)
  return self:run({ "show", ref .. ":" .. path })
end

return M
