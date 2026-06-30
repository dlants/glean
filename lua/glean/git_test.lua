-- Tier 2 tests for glean.git against a hermetic git fixture. Run with:
--   nvim -l nvim/lua/glean/git_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local git_mod = require("glean.git")
local testutil = require("glean.testutil")
local h = testutil.new()

-- A multi-commit fixture: base on main, a branch with several commits editing
-- overlapping regions of the same file plus an added file.
local repo = testutil.make_repo({
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n" } },
  { msg = "c1: edit two", files = { ["f.txt"] = "one\nTWO\nthree\n" } },
  { msg = "c2: edit three + add g", files = {
    ["f.txt"] = "one\nTWO\nTHREE\n",
    ["g.txt"] = "gee\n",
  } },
})

local base = repo.shas[1]
local target = repo.shas[3]
local git = git_mod.new({
  repo_root = repo.root,
  run = function(args)
    local cmd = { "git" }
    for _, a in ipairs(args) do cmd[#cmd + 1] = a end
    local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
    return { code = res.code, stdout = res.stdout, stderr = res.stderr }
  end,
})

-- commits(): the two commits beyond base, chronological.
do
  local commits = git:commits(base, target)
  h.assert_eq("commits: count", #commits, 2)
  h.assert_eq("commits: first sha", commits[1].sha, repo.shas[2])
  h.assert_eq("commits: first summary", commits[1].summary, "c1: edit two")
  h.assert_eq("commits: second sha", commits[2].sha, repo.shas[3])
end

-- commit_diff(): c1 only touched f.txt's "two" -> "TWO".
do
  local files = git:commit_diff(repo.shas[2])
  h.assert_eq("commit_diff: one file", #files, 1)
  h.assert_eq("commit_diff: path", files[1].path, "f.txt")
  local adds = {}
  for _, l in ipairs(files[1].hunks[1].lines) do
    if l.kind == "add" then adds[#adds + 1] = l end
  end
  h.assert_eq("commit_diff: one add", #adds, 1)
  h.assert_eq("commit_diff: add text", adds[1].text, "TWO")
  h.assert_eq("commit_diff: add new_lnum", adds[1].new_lnum, 2)
end

-- combined_diff(): net of c1+c2 over base -> two files (f.txt, g.txt).
do
  local files = git:combined_diff(base, target)
  h.assert_eq("combined: two files", #files, 2)
  local by_path = {}
  for _, f in ipairs(files) do by_path[f.path] = f end
  h.assert_true("combined: has f.txt", by_path["f.txt"] ~= nil)
  h.assert_true("combined: has g.txt", by_path["g.txt"] ~= nil)
  h.assert_eq("combined: g.txt is add", by_path["g.txt"].kind, "add")
  -- f.txt net: two->TWO and three->THREE both present as adds.
  local addtext = {}
  for _, hunk in ipairs(by_path["f.txt"].hunks) do
    for _, l in ipairs(hunk.lines) do
      if l.kind == "add" then addtext[l.text] = true end
    end
  end
  h.assert_true("combined: f.txt has TWO add", addtext["TWO"])
  h.assert_true("combined: f.txt has THREE add", addtext["THREE"])
end

-- range_diff() restricted to a path mirrors combined for that file alone.
do
  local files = git:range_diff(base, target, "g.txt")
  h.assert_eq("range_diff path: one file", #files, 1)
  h.assert_eq("range_diff path: g.txt", files[1].path, "g.txt")
end

-- show(): contents of f.txt at the base ref.
do
  local out = git:show(base, "f.txt")
  h.assert_eq("show: base f.txt", out, "one\ntwo\nthree\n")
end

-- blame() returns porcelain output naming the owning sha for a line.
do
  local out = git:blame(target, "f.txt", 2, 2)
  h.assert_true("blame: nonempty", out ~= nil and #out > 0)
  h.assert_true("blame: names c1 sha", out:find(repo.shas[2], 1, true) ~= nil)
end

-- blame() accepts a list of { first, last } ranges (multiple -L spans).
do
  local out = git:blame(target, "f.txt", { { 1, 1 }, { 3, 3 } })
  h.assert_true("blame ranges: nonempty", out ~= nil and #out > 0)
end

-- run_async() under an injected runner returns the same stdout as sync blame,
-- and nil on the error path.
do
  local sync_out = git:blame(target, "f.txt", 2, 2)
  local async_out, async_err
  git:run_async({ "blame", "-p", "-L", "2,2", target, "--", "f.txt" }, function(out, err)
    async_out = out; async_err = err
  end)
  h.assert_eq("run_async: matches sync blame", async_out, sync_out)
  h.assert_true("run_async: no error", async_err == nil)

  local err_out, saw_err
  git:run_async({ "blame", "-p", "nonexistent-ref", "--", "nope.txt" }, function(out, err)
    err_out = out; saw_err = err
  end)
  h.assert_true("run_async: error path nil stdout", err_out == nil)
  h.assert_true("run_async: error path has stderr", saw_err ~= nil)
end

-- run_async() against a real repo (run=nil) yields blame output asynchronously.
do
  local real_git = git_mod.new({ repo_root = repo.root })
  local done, real_out
  real_git:run_async({ "blame", "-p", "-L", "1,1", target, "--", "f.txt" }, function(out)
    real_out = out; done = true
  end)
  vim.wait(5000, function() return done end)
  h.assert_true("run_async real: completed", done == true)
  h.assert_true("run_async real: nonempty", real_out ~= nil and #real_out > 0)
end

-- rev_parse resolves a ref to a sha.
do
  h.assert_eq("rev_parse: target", git:rev_parse(target), target)
end

-- Stage 1: working-tree plumbing. Leave the fixture dirty: a staged edit, an
-- unstaged edit, and an untracked file.
do
  local function write(path, content)
    local f = assert(io.open(repo.root .. "/" .. path, "w"))
    f:write(content)
    f:close()
  end

  -- f.txt at HEAD is "one\nTWO\nTHREE\n". Stage an edit to line 1, then make a
  -- further unstaged edit to line 3.
  write("f.txt", "ONE\nTWO\nTHREE\n")
  repo.run({ "add", "--", "f.txt" })
  write("f.txt", "ONE\nTWO\nthree-dirty\n")
  -- An untracked file (honors .gitignore via --exclude-standard).
  write("u.txt", "alpha\nbeta\n")
end

-- merge_base(): fork point of two refs. main is linear here, so the merge base
-- of base and target is base itself.
do
  h.assert_eq("merge_base: linear", git:merge_base(base, target), base)
  local direct = repo.run({ "merge-base", base, target })
  h.assert_eq("merge_base: matches git", git:merge_base(base, target), direct)
end

-- worktree_diff(): git diff HEAD picks up staged + unstaged tracked edits.
do
  local files = git:worktree_diff()
  h.assert_eq("worktree_diff: one tracked file", #files, 1)
  h.assert_eq("worktree_diff: path", files[1].path, "f.txt")
  local addtext = {}
  for _, hunk in ipairs(files[1].hunks) do
    for _, l in ipairs(hunk.lines) do
      if l.kind == "add" then addtext[l.text] = true end
    end
  end
  h.assert_true("worktree_diff: staged ONE add", addtext["ONE"])
  h.assert_true("worktree_diff: unstaged three-dirty add", addtext["three-dirty"])
end

-- diff_to_worktree(base): everything since base, committed + uncommitted.
do
  local files = git:diff_to_worktree(base)
  local by_path = {}
  for _, f in ipairs(files) do by_path[f.path] = f end
  h.assert_true("diff_to_worktree: has f.txt", by_path["f.txt"] ~= nil)
  h.assert_true("diff_to_worktree: has g.txt", by_path["g.txt"] ~= nil)
  local addtext = {}
  for _, hunk in ipairs(by_path["f.txt"].hunks) do
    for _, l in ipairs(hunk.lines) do
      if l.kind == "add" then addtext[l.text] = true end
    end
  end
  h.assert_true("diff_to_worktree: committed TWO", addtext["TWO"])
  h.assert_true("diff_to_worktree: dirty three-dirty", addtext["three-dirty"])
end

-- untracked(): synthesized all-addition FileEntry for the untracked file.
do
  local files = git:untracked()
  h.assert_eq("untracked: one file", #files, 1)
  local f = files[1]
  h.assert_eq("untracked: path", f.path, "u.txt")
  h.assert_eq("untracked: kind add", f.kind, "add")
  h.assert_eq("untracked: one hunk", #f.hunks, 1)
  local lines = f.hunks[1].lines
  h.assert_eq("untracked: two lines", #lines, 2)
  h.assert_eq("untracked: line1 text", lines[1].text, "alpha")
  h.assert_eq("untracked: line1 new_lnum", lines[1].new_lnum, 1)
  h.assert_eq("untracked: line2 new_lnum", lines[2].new_lnum, 2)
  h.assert_true("untracked: all adds", lines[1].kind == "add" and lines[2].kind == "add")
end

-- Diff paths are stripped to bare repo-relative paths even when the user's git
-- config enables mnemonic prefixes (`w/`, `i/`, ...). The real default runner
-- (run=nil) must pin the prefix config off so the parser's `a/`/`b/` stripping
-- holds; here the repo locally enables mnemonicPrefix to prove the override.
do
  repo.run({ "config", "diff.mnemonicPrefix", "true" })
  local plain_git = git_mod.new({ repo_root = repo.root })
  local files = plain_git:combined_diff(base, target)
  local paths = {}
  for _, f in ipairs(files) do paths[f.path] = true end
  h.assert_true("mnemonicPrefix: f.txt unprefixed", paths["f.txt"])
  h.assert_true("mnemonicPrefix: g.txt unprefixed", paths["g.txt"])
  h.assert_true("mnemonicPrefix: no w/ prefix leaked",
    not paths["w/f.txt"] and not paths["i/f.txt"])
end
-- common_dir(): absolute path to the repo's shared .git, identical across linked
-- worktrees (so the per-repo store dir is stable), distinct across repos.
do
  local cd = git:common_dir()
  h.assert_true("common_dir: absolute", cd:sub(1, 1) == "/")
  h.assert_true("common_dir: points at .git", cd:sub(-4) == ".git")

  -- A linked worktree of the same repo resolves to the same common dir.
  local wt = repo.root .. "/../glean_wt_" .. tostring(vim.fn.getpid())
  repo.run({ "worktree", "add", "--detach", wt })
  local wt_git = git_mod.new({
    repo_root = wt,
    run = function(args)
      local cmd = { "git" }
      for _, a in ipairs(args) do cmd[#cmd + 1] = a end
      local res = vim.system(cmd, { cwd = wt, env = repo.env, text = true }):wait()
      return { code = res.code, stdout = res.stdout, stderr = res.stderr }
    end,
  })
  h.assert_eq("common_dir: shared across worktrees", wt_git:common_dir(), cd)
  repo.run({ "worktree", "remove", "--force", wt })

  -- A distinct repo resolves elsewhere.
  local other = testutil.make_repo({ { msg = "x", files = { ["a"] = "a\n" } } })
  local other_git = git_mod.new({
    repo_root = other.root,
    run = function(args)
      local cmd = { "git" }
      for _, a in ipairs(args) do cmd[#cmd + 1] = a end
      local res = vim.system(cmd, { cwd = other.root, env = other.env, text = true }):wait()
      return { code = res.code, stdout = res.stdout, stderr = res.stderr }
    end,
  })
  h.assert_true("common_dir: distinct repos diverge", other_git:common_dir() ~= cd)
end

h.finish()
