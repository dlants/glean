-- The async refresh pipeline: the join helper's fan-out shape, and the
-- guarantee that a refresh paints the buffer exactly once (or not at all when
-- it is superseded / the buffer is gone). Run with:
--   nvim -l lua/glean/async_test.lua
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path
local glean = require("glean.init")
local git_mod = require("glean.git")
local testutil = require("glean.testutil")
local h = testutil.new()
local api = vim.api

-- 1. join: every job is started before any of them completes, the continuation
-- fires exactly once, and it fires only after the last job lands (in whatever
-- order they land).
do
  local started, landed = {}, {}
  local dones = {}
  local calls = 0
  local function job(name)
    return function(done)
      started[#started + 1] = name
      landed[name] = false
      dones[name] = done
    end
  end
  git_mod.join({ a = job("a"), b = job("b"), c = job("c") }, function(res)
    calls = calls + 1
    landed.result = res
  end)
  h.assert_eq("join: all jobs started", #started, 3)
  h.assert_eq("join: no continuation before any lands", calls, 0)
  dones.c("C")
  dones.a("A")
  h.assert_eq("join: no continuation while one is pending", calls, 0)
  dones.b("B")
  h.assert_eq("join: continuation ran once", calls, 1)
  h.assert_eq("join: result a", landed.result.a[1], "A")
  h.assert_eq("join: result b", landed.result.b[1], "B")
  h.assert_eq("join: result c", landed.result.c[1], "C")
  dones.a("again")
  h.assert_eq("join: extra landings don't re-run", calls, 1)
end
do
  local calls = 0
  git_mod.join({}, function() calls = calls + 1 end)
  h.assert_eq("join: empty job set still continues", calls, 1)
end

local repo = testutil.make_repo({
  { msg = "base", files = { ["f.txt"] = "one\ntwo\nthree\n" } },
  { msg = "c1: edit two", files = { ["f.txt"] = "one\nTWO\nthree\n" } },
})
local function inject_run(args)
  local cmd = { "git" }
  for _, a in ipairs(args) do cmd[#cmd + 1] = a end
  local res = vim.system(cmd, { cwd = repo.root, env = repo.env, text = true }):wait()
  return { code = res.code, stdout = res.stdout, stderr = res.stderr }
end

-- 2. poll_async fans its two independent queries out together rather than
-- chaining them.
do
  local git = git_mod.new({ repo_root = repo.root, run = inject_run })
  local issued, queue = {}, {}
  git.run_async = function(_, args, cb)
    issued[#issued + 1] = args[1]
    queue[#queue + 1] = { args = args, cb = cb }
  end
  local sig, calls = nil, 0
  git:poll_async(function(s) calls = calls + 1; sig = s end)
  h.assert_eq("poll_async: two queries issued", #issued, 2)
  h.assert_eq("poll_async: none has completed yet", calls, 0)
  for _, q in ipairs(queue) do
    local out, err = git_mod.new({ repo_root = repo.root, run = inject_run }):run(q.args)
    q.cb(out, err)
  end
  h.assert_eq("poll_async: one continuation", calls, 1)
  h.assert_true("poll_async: produced a signature", type(sig) == "string" and #sig > 0)
end

local state_dir = vim.fn.tempname()
local function open(o)
  o = o or {}
  return glean.open({
    base = repo.shas[1],
    target = repo.shas[2],
    repo_root = repo.root,
    run = inject_run,
    open_window = false,
    state_dir = o.state_dir or state_dir,
  })
end

-- 3. Under the injected (synchronous) runner the whole pipeline completes
-- inside `open`: the model is there and the buffer is painted by the time it
-- returns. Every existing suite's open()-then-assert style depends on this.
local Session
do
  local s = open()
  Session = getmetatable(s)
  h.assert_true("open: model landed synchronously", #s.files > 0)
  h.assert_true("open: commits landed synchronously", #s.commits > 0)
  local body = table.concat(api.nvim_buf_get_lines(s.buf, 0, -1, false), "\n")
  h.assert_true("open: buffer painted", body:find("f.txt", 1, true) ~= nil)
end

-- Count renders across a piece of work by wrapping the shared Session method.
local function count_renders(fn)
  local orig = Session.render
  local n = 0
  Session.render = function(self, ...)
    n = n + 1
    return orig(self, ...)
  end
  local ok, err = pcall(fn)
  Session.render = orig
  if not ok then error(err) end
  return n
end

-- 4. A refresh paints exactly once, no matter how many queries it fans out.
do
  local s = open()
  local n = count_renders(function() s:reload() end)
  h.assert_eq("reload: exactly one repaint", n, 1)
end
do
  local n = count_renders(function() open() end)
  h.assert_eq("open: exactly one repaint", n, 1)
end

-- Swap a session's git handle for one that queues its async calls instead of
-- running them, so a refresh can be caught mid-flight. Returns a drain function
-- that runs the queued calls (including any they enqueue in turn).
local function defer(s)
  local queue = {}
  s.git.run_async = function(g, args, cb)
    queue[#queue + 1] = function() cb(g:run(args)) end
  end
  return function()
    local i = 0
    while i < #queue do
      i = i + 1
      queue[i]()
    end
  end
end

-- 5. A refresh superseded mid-flight drops itself: only the winning refresh
-- paints, and its model is what lands.
do
  local s = open()
  local drain = defer(s)
  local n = count_renders(function()
    s:reload()
    s:reload()
    drain()
  end)
  h.assert_eq("superseded: only the winner repaints", n, 1)
  h.assert_true("superseded: winner's model landed", #s.files > 0)
end

-- 6. The buffer going away mid-flight aborts cleanly: the late callbacks run
-- without error and paint nothing.
do
  local s = open()
  local drain = defer(s)
  local n = count_renders(function()
    s:reload()
    api.nvim_buf_delete(s.buf, { force = true })
    drain()
  end)
  h.assert_eq("closed buffer: no repaint", n, 0)
end

h.finish()
