-- Tests for glean.lineage. Run with:
--   nvim -l lua/glean/lineage_test.lua
--
-- Three groups:
--   1. line arithmetic  — splice/expand geometry with placeholder origins
--   2. attribution      — who owns what, over hand-built FileEntries
--   3. real histories   — throwaway repos, the real log query, and a checker
--                         that verifies every coordinate against blob content
local this_script = debug.getinfo(1, "S").source:sub(2)
local this_dir = this_script:match("(.+)/[^/]+$") or "."
local lua_root = this_dir:match("(.+)/[^/]+$") or "."
package.path = lua_root .. "/?.lua;" .. lua_root .. "/?/init.lua;" .. package.path

local testutil = require("glean.testutil")
local lineage = require("glean.lineage")
local diff = require("glean.diff")
local h = testutil.new()

-- ---------------------------------------------------------------- helpers

-- Render an expanded origin list compactly so assertions read as strings.
local function show(origins)
  local out = {}
  for i, o in ipairs(origins) do
    out[i] = o.base and ("b" .. o.base) or (o.sha .. ":" .. o.lnum)
  end
  return table.concat(out, " ")
end

local function seg(sha, lnum, n) return { sha = sha, lnum = lnum, n = n } end

-- A finite placeholder file: five base lines, then the open tail.
local function base5()
  return { { base = 1, n = 5 }, { base = 6 } }
end

-- ------------------------------------------------------ 1. line arithmetic

do
  local s = lineage.splice(base5(), 3, 2, seg("x", 10, 2))
  h.assert_eq("replace in middle", show(lineage.expand(s, 6)),
    "b1 b2 x:10 x:11 b5 b6")
end

do
  local s = lineage.splice(base5(), 3, 2, seg("x", 1, 5))
  h.assert_eq("wider replacement shifts down", show(lineage.expand(s, 9)),
    "b1 b2 x:1 x:2 x:3 x:4 x:5 b5 b6")
end

do
  local s = lineage.splice(base5(), 2, 5, seg("x", 1, 2))
  h.assert_eq("narrower replacement shifts up", show(lineage.expand(s, 5)),
    "b1 x:1 x:2 b7 b8")
end

do
  local s = lineage.splice(base5(), 1, 0, seg("x", 1, 1))
  h.assert_eq("prepend", show(lineage.expand(s, 4)), "x:1 b1 b2 b3")
end

do
  local s = lineage.splice(base5(), 4, 0, seg("x", 4, 1))
  h.assert_eq("insert in middle", show(lineage.expand(s, 6)),
    "b1 b2 b3 x:4 b4 b5")
end

do
  -- Appending past the known-length segments lands in the open tail, whose
  -- length is unknown.
  local s = lineage.splice(base5(), 8, 0, seg("x", 8, 1))
  h.assert_eq("insert into open tail", show(lineage.expand(s, 9)),
    "b1 b2 b3 b4 b5 b6 b7 x:8 b8")
end

do
  local s = lineage.splice(base5(), 2, 2, nil)
  h.assert_eq("delete-only closes the gap", show(lineage.expand(s, 4)),
    "b1 b4 b5 b6")
  h.assert_eq("delete-only leaves no empty segment", #s, 3)
end

do
  local s = lineage.splice({ { base = 1, n = 2 }, seg("x", 1, 3), { base = 3 } }, 3, 3, nil)
  h.assert_eq("splice covering a whole segment removes it", #s, 2)
  h.assert_eq("splice covering a whole segment", show(lineage.expand(s, 4)),
    "b1 b2 b3 b4")
end

do
  local segs = { { base = 1, n = 2 }, seg("x", 1, 2), seg("y", 5, 2), { base = 3 } }
  local s, displaced = lineage.splice(segs, 2, 5, seg("z", 1, 1))
  h.assert_eq("multi-segment splice", show(lineage.expand(s, 4)), "b1 z:1 b3 b4")
  h.assert_eq("displaced spans all segments", show(displaced), "b2 x:1 x:2 y:5 y:6")
end

do
  -- Two hunks in one commit: the second hunk's coordinates are pre-image
  -- coordinates, so applying it naively against the mutated list is wrong.
  local file = {
    path = "f",
    old_path = "f",
    kind = "modify",
    hunks = {
      { old_start = 2, old_count = 1, new_start = 2, new_count = 3, lines = {
        { kind = "del", text = "b", old_lnum = 2 },
        { kind = "add", text = "B1", new_lnum = 2 },
        { kind = "add", text = "B2", new_lnum = 3 },
        { kind = "add", text = "B3", new_lnum = 4 },
      } },
      { old_start = 4, old_count = 1, new_start = 6, new_count = 1, lines = {
        { kind = "del", text = "d", old_lnum = 4 },
        { kind = "add", text = "D", new_lnum = 6 },
      } },
    },
  }
  local st = lineage.apply({ segs = base5(), del_attr = {} }, "c1", file)
  h.assert_eq("two hunks use pre-image coordinates", show(lineage.expand(st.segs, 7)),
    "b1 c1:2 c1:3 c1:4 b3 c1:6 b5")
end

do
  -- Segment count must stay O(hunks), not O(lines).
  local segs = base5()
  for i = 1, 50 do
    segs = lineage.splice(segs, i, 0, seg("x", i, 1))
  end
  h.assert_true("segment count is O(splices)", #segs <= 2 * 50 + 2, tostring(#segs))
end

-- ---------------------------------------------------------- 2. attribution

-- Build a FileEntry with a single change block.
local function entry(path, opts)
  local lines = {}
  for i = 1, (opts.dels or 0) do
    lines[#lines + 1] = { kind = "del", text = "-", old_lnum = opts.at + i - 1 }
  end
  for i = 1, (opts.adds or 0) do
    lines[#lines + 1] = { kind = "add", text = "+", new_lnum = opts.new_lnum + i - 1 }
  end
  return {
    path = path,
    old_path = opts.old_path or path,
    kind = opts.kind or "modify",
    hunks = { {
      old_start = (opts.dels or 0) > 0 and opts.at or (opts.at - 1),
      old_count = opts.dels or 0,
      new_start = opts.new_lnum or 1,
      new_count = opts.adds or 0,
      lines = lines,
    } },
  }
end

do
  local st = lineage.apply({ segs = base5(), del_attr = {} }, "c1",
    entry("f", { at = 3, adds = 1, new_lnum = 3 }))
  h.assert_eq("add owns its position", show(lineage.expand(st.segs, 5)),
    "b1 b2 c1:3 b3 b4")
end

do
  -- c1 adds at 3; c2 then prepends, so the running position and the recorded
  -- lnum differ.
  local st = { segs = base5(), del_attr = {} }
  lineage.apply(st, "c1", entry("f", { at = 3, adds = 1, new_lnum = 3 }))
  lineage.apply(st, "c2", entry("f", { at = 1, adds = 2, new_lnum = 1 }))
  h.assert_eq("lnum is the commit's own number, not the position",
    show(lineage.expand(st.segs, 6)), "c2:1 c2:2 b1 b2 c1:3 b3")
end

do
  -- c1 inserts two lines, so base line 3 is at pre-image position 5 for c2.
  local st = { segs = base5(), del_attr = {} }
  lineage.apply(st, "c1", entry("f", { at = 1, adds = 2, new_lnum = 1 }))
  lineage.apply(st, "c2", entry("f", { at = 5, dels = 1 }))
  h.assert_eq("del keyed by base lnum", st.del_attr[3] and st.del_attr[3].sha, "c2")
  h.assert_eq("del records the deleter's pre-image lnum", st.del_attr[3].lnum, 5)
  h.assert_eq("nothing keyed by the deleter's lnum", st.del_attr[5], nil)
end

do
  local st = { segs = base5(), del_attr = {} }
  lineage.apply(st, "c1", entry("f", { at = 3, adds = 1, new_lnum = 3 }))
  lineage.apply(st, "c2", entry("f", { at = 3, dels = 1 }))
  h.assert_eq("transient line records no attribution", next(st.del_attr), nil)
  h.assert_eq("transient line leaves no trace", show(lineage.expand(st.segs, 5)),
    "b1 b2 b3 b4 b5")
end

do
  local out = lineage.compose({
    { sha = "c1", files = { entry("f", { at = 3, dels = 1, adds = 1, new_lnum = 3 }) } },
    { sha = "c2", files = { entry("f", { at = 3, dels = 1, adds = 1, new_lnum = 3 }) } },
  })
  h.assert_eq("last writer wins", out.f.prov[3].sha, "c2")
  h.assert_eq("earlier writer gone", out.f.prov[3].lnum, 3)
  h.assert_eq("base survivors get no prov entry", out.f.prov[1], nil)
end

do
  local rename = entry("g", { at = 3, dels = 1, adds = 1, new_lnum = 3, kind = "rename" })
  rename.old_path = "f"
  local out = lineage.compose({
    { sha = "c1", files = { entry("f", { at = 1, adds = 1, new_lnum = 1 }) } },
    { sha = "c2", files = { rename } },
  })
  h.assert_eq("rename carries origins to the new path", out.g.prov[1].sha, "c1")
  h.assert_eq("old path is gone", out.f, nil)
  h.assert_eq("rename edit owned by renamer", out.g.prov[3].sha, "c2")
end

do
  local del = entry("f", { at = 1, dels = 5, kind = "delete" })
  local readd = entry("f", { at = 1, adds = 2, new_lnum = 1, kind = "add" })
  local out = lineage.compose({
    { sha = "c1", files = { del } },
    { sha = "c2", files = { readd } },
  })
  h.assert_eq("delete attributes base lines", out.f.del_attr[4].sha, "c1")
  h.assert_eq("re-added lines owned by the re-adder", out.f.prov[1].sha, "c2")
  h.assert_eq("nothing survives the delete", out.f.prov[3], nil)
end

do
  local WORKTREE = "WORKTREE"
  local out = lineage.compose({
    { sha = WORKTREE, files = { entry("f", { at = 2, adds = 1, new_lnum = 2 }) } },
  })
  h.assert_eq("work-tree layer is an ordinary layer", out.f.prov[2].sha, WORKTREE)
end

-- ------------------------------------------------------- 3. real histories

-- Stand-in for the Git:log_patches query added in the next stage: one
-- first-parent log walk, split on the NUL sentinel, each chunk parsed by
-- glean.diff.
local function log_patches(repo, base, target)
  local out = repo.run({
    "log", "--first-parent", "--reverse", "-p", "-U0", "-M", "--no-color",
    "--format=%x00%H", base .. ".." .. target,
  })
  local patches = {}
  for chunk in out:gmatch("%z([^%z]*)") do
    local sha, rest = chunk:match("^(%x+)\n?(.*)$")
    patches[#patches + 1] = { sha = sha, files = diff.parse(rest or "") }
  end
  return patches
end

local function blob_lines(repo, rev, path)
  local ok, out = pcall(repo.run, { "show", rev .. ":" .. path })
  if not ok then return nil end
  return vim.split(out, "\n", { plain = true })
end

local function blob_line(repo, rev, path, lnum)
  local lines = blob_lines(repo, rev, path)
  return lines and lines[lnum]
end

-- The correctness property: a coordinate is right iff the blob content at that
-- coordinate is the line we claim it is. Walks every entry of every path's
-- prov/del_attr, plus the net diff from the other side.
local function check(name, repo, base, target)
  local composed = lineage.compose(log_patches(repo, base, target))
  local net = diff.parse(repo.run({ "diff", "-M", "--no-color", base, target }))
  local bad = nil
  local function fail(msg)
    bad = bad or msg
  end

  for _, file in ipairs(net) do
    local maps = composed[file.path] or { prov = {}, del_attr = {} }
    for _, hunk in ipairs(file.hunks) do
      for _, dl in ipairs(hunk.lines) do
        if dl.kind == "add" then
          local o = maps.prov[dl.new_lnum]
          if not o then
            fail(("no prov for %s:%d (%s)"):format(file.path, dl.new_lnum, dl.text))
          else
            -- Under a rename the owning commit may know the file by its old
            -- name, so check both spellings.
            local got = blob_line(repo, o.sha, file.path, o.lnum)
              or blob_line(repo, o.sha, file.old_path, o.lnum)
            if got ~= dl.text then
              fail(("prov %s:%d -> %s:%d is %q, want %q")
                :format(file.path, dl.new_lnum, o.sha:sub(1, 7), o.lnum,
                  tostring(got), dl.text))
            end
          end
        elseif dl.kind == "del" then
          local o = maps.del_attr[dl.old_lnum]
          if not o then
            fail(("no del_attr for %s:%d (%s)"):format(file.path, dl.old_lnum, dl.text))
          else
            local old_path = file.old_path ~= "/dev/null" and file.old_path or file.path
            local got = blob_line(repo, o.sha .. "^", old_path, o.lnum)
              or blob_line(repo, o.sha .. "^", file.path, o.lnum)
            if got ~= dl.text then
              fail(("del_attr %s:%d -> %s:%d is %q, want %q")
                :format(file.path, dl.old_lnum, o.sha:sub(1, 7), o.lnum,
                  tostring(got), dl.text))
            end
            local at_base = blob_line(repo, base, old_path, dl.old_lnum)
            if at_base ~= dl.text then
              fail(("base %s:%d is %q, want %q")
                :format(old_path, dl.old_lnum, tostring(at_base), dl.text))
            end
          end
        end
      end
    end
  end

  h.assert_true(name, bad == nil, bad)
  return composed
end

local BASE = "one\ntwo\nthree\nfour\nfive\n"

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "edit", files = { ["f.txt"] = "one\ntwo\nTHREE\nfour\nfive\n" } },
  })
  local c = check("single edit", repo, repo.shas[1], repo.shas[2])
  h.assert_eq("single edit owner", c["f.txt"].prov[3].sha, repo.shas[2])
  h.assert_eq("single edit lnum", c["f.txt"].prov[3].lnum, 3)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "one\ntwo\nTHREE\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = "a\nb\none\ntwo\nTHREE\nfour\nfive\n" } },
  })
  local c = check("shifted by a later insert", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("origin does not track the final image", c["f.txt"].prov[5].sha, repo.shas[2])
  h.assert_eq("origin keeps the writer's lnum", c["f.txt"].prov[5].lnum, 3)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "a\nb\none\ntwo\nthree\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = "a\nb\none\ntwo\nTHREE\nfour\nfive\n" } },
  })
  local c = check("shifted by an earlier insert", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("owner is the rewriter", c["f.txt"].prov[5].sha, repo.shas[3])
  h.assert_eq("lnum is the rewriter's number", c["f.txt"].prov[5].lnum, 5)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "a\nb\none\ntwo\nthree\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = "a\nb\none\ntwo\nfour\nfive\n" } },
  })
  local c = check("deletion attribution", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("keyed by base lnum", c["f.txt"].del_attr[3].sha, repo.shas[3])
  h.assert_eq("lnum in the deleter's pre-image", c["f.txt"].del_attr[3].lnum, 5)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "one\ntwo\ntransient\nthree\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = BASE } },
  })
  local c = check("transient line", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("transient line has no prov", next(c["f.txt"].prov), nil)
  h.assert_eq("transient line has no del_attr", next(c["f.txt"].del_attr), nil)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "one\ntwo\nTHREE\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = "one\ntwo\nTHREE\nfour\nFIVE\n" } },
    { msg = "c3", files = { ["f.txt"] = "one\ntwo\nthird\nfour\nFIVE\n" } },
  })
  local c = check("rewritten twice", repo, repo.shas[1], repo.shas[4])
  h.assert_eq("owned by the last writer", c["f.txt"].prov[3].sha, repo.shas[4])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "prepend", files = { ["f.txt"] = "zero\n" .. BASE } },
  })
  local c = check("pure prepend", repo, repo.shas[1], repo.shas[2])
  h.assert_eq("prepended line owns position 1", c["f.txt"].prov[1].lnum, 1)
  h.assert_eq("nothing else owned", c["f.txt"].prov[2], nil)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "append", files = { ["f.txt"] = BASE .. "six\n" } },
  })
  local c = check("pure append", repo, repo.shas[1], repo.shas[2])
  h.assert_eq("appended line owns the last position", c["f.txt"].prov[6].lnum, 6)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "adjacent", files = { ["f.txt"] = "one\nTWO\nTHREE\nX\nfour\nfive\n" } },
  })
  check("adjacent hunks", repo, repo.shas[1], repo.shas[2])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "one\nTWO\nthree\nfour\nfive\n" } },
    {
      msg = "rename+edit",
      rename = { ["f.txt"] = "g.txt" },
      files = { ["g.txt"] = "one\nTWO\nthree\nFOUR\nfive\n" },
    },
  })
  local c = check("rename", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("origins carry across the rename", c["g.txt"].prov[2].sha, repo.shas[2])
  h.assert_eq("old path empty", c["f.txt"], nil)
  h.assert_eq("edited line owned by the renamer", c["g.txt"].prov[4].sha, repo.shas[3])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "one\nTWO\nthree\nfour\nfive\n" } },
    { msg = "pure rename", rename = { ["f.txt"] = "g.txt" } },
  })
  local c = check("rename with no content change", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("state moved by the pure rename", c["g.txt"].prov[2].sha, repo.shas[2])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE, ["k.txt"] = "k\n" } },
    { msg = "delete", delete = { "f.txt" } },
    { msg = "re-add", files = { ["f.txt"] = "alpha\nbeta\n" } },
  })
  local c = check("delete then re-add", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("base lines attributed to the deleter", c["f.txt"].del_attr[2].sha, repo.shas[2])
  h.assert_eq("new lines owned by the re-adder", c["f.txt"].prov[1].sha, repo.shas[3])
  h.assert_eq("nothing survives", c["f.txt"].prov[3], nil)
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "new file", files = { ["n.txt"] = "a\nb\nc\n" } },
  })
  local c = check("new file", repo, repo.shas[1], repo.shas[2])
  h.assert_eq("every line owned by the adder", c["n.txt"].prov[3].sha, repo.shas[2])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "empty", empty = true },
    { msg = "edit", files = { ["f.txt"] = "one\ntwo\nTHREE\nfour\nfive\n" } },
  })
  local c = check("empty commit", repo, repo.shas[1], repo.shas[3])
  h.assert_eq("empty commit does not disturb coordinates", c["f.txt"].prov[3].sha, repo.shas[3])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "main edit", files = { ["f.txt"] = "ONE\ntwo\nthree\nfour\nfive\n" } },
    { msg = "side", branch = "side", files = { ["s.txt"] = "s1\ns2\n" } },
    { msg = "merge side", merge = "side" },
  })
  local c = check("merge", repo, repo.shas[1], repo.shas[4])
  h.assert_eq("side branch lines owned by the merge", c["s.txt"].prov[1].sha, repo.shas[4])
  h.assert_eq("side commit contributes nothing", c["s.txt"].prov[1].sha ~= repo.shas[3], true)
end

-- Randomized histories: the content checker over generated edits. This is where
-- off-by-one and segment-splicing bugs actually surface.
local function rand_history(seed)
  math.randomseed(seed)
  local paths = { "a.txt", "b.txt" }
  local content = {}
  for _, p in ipairs(paths) do
    local lines = {}
    for i = 1, 12 do lines[i] = p .. "-" .. i end
    content[p] = lines
  end
  local function snapshot()
    local files = {}
    for p, lines in pairs(content) do
      files[p] = #lines > 0 and (table.concat(lines, "\n") .. "\n") or "\n"
    end
    return files
  end

  local spec = { { msg = "base", files = snapshot() } }
  local counter = 0
  for c = 1, 6 do
    local p = paths[math.random(#paths)]
    local lines = content[p]
    for _ = 1, math.random(3) do
      local op = math.random(3)
      local at = math.random(math.max(1, #lines))
      if op == 1 and #lines > 1 then
        table.remove(lines, at)
      elseif op == 2 then
        counter = counter + 1
        table.insert(lines, at, "new-" .. counter)
      else
        counter = counter + 1
        lines[at] = "mod-" .. counter
      end
    end
    -- allow-empty: a random pass may leave the content unchanged.
    spec[#spec + 1] = { msg = "c" .. c, files = snapshot(), empty = true }
  end
  return spec
end

for seed = 1, 8 do
  local repo = testutil.make_repo(rand_history(seed))
  check("randomized history seed " .. seed, repo, repo.shas[1], repo.shas[#repo.shas])
end

-- --------------------------------------------------- 4. blame-oracle equivalence
--
-- The content check above proves the *coordinates* are real but not that the
-- *attribution* is right: crediting the wrong commit still passes whenever that
-- commit happens to carry the same text at the same line. Blame is the
-- independent authority on which commit, so both checks are needed and neither
-- subsumes the other.
--
-- The oracle applies to merge-free ranges only. On a merge, blame reaches into
-- the side branch while composition credits the merge commit, so the two are
-- *intended* to disagree; that case is asserted against composition directly
-- (see the merge fixture above).

-- `git blame -p` porcelain -> final_lnum -> { sha, orig_lnum }. Lifted from
-- glean.provenance, which this plan deletes once nothing in production blames.
local function parse_blame(text)
  local map = {}
  for line in (text .. "\n"):gmatch("(.-)\n") do
    local sha, orig, final = line:match("^(%x+) (%d+) (%d+)")
    if sha and #sha >= 7 then
      map[tonumber(final)] = { sha = sha, orig_lnum = tonumber(orig) }
    end
  end
  return map
end

-- Reverse blame reports, per base line, the *last* revision in which the line
-- still existed; the deleter is that revision's first-parent child. Mirrors
-- init.lua's build_del_map.
local function build_del_map(text, child)
  local map = {}
  for final, p in pairs(parse_blame(text or "")) do
    local deleter = child[p.sha]
    if deleter then map[final] = { sha = deleter, lnum = p.orig_lnum } end
  end
  return map
end

local function child_map(repo, base, target)
  local child, prev = {}, repo.run({ "rev-parse", base })
  for _, p in ipairs(log_patches(repo, base, target)) do
    child[prev] = p.sha
    prev = p.sha
  end
  return child
end

local function fmt(o)
  return o and (o.sha:sub(1, 7) .. ":" .. (o.lnum or o.orig_lnum)) or "nil"
end

-- Assert composition reproduces blame for every add/del line of the net diff.
-- `expect` optionally names deliberate divergences:
--   expect[path]["add"|"del"][lnum] = { sha = <sha>, lnum = <n> }
-- which are asserted against the *composition* answer instead of blame.
local function oracle(name, repo, base, target, expect)
  local composed = lineage.compose(log_patches(repo, base, target))
  local net = diff.parse(repo.run({ "diff", "-M", "--no-color", base, target }))
  local child = child_map(repo, base, target)
  local bad = nil
  local function fail(msg) bad = bad or msg end

  for _, file in ipairs(net) do
    local maps = composed[file.path] or { prov = {}, del_attr = {} }
    local exp = (expect or {})[file.path] or {}
    local blame, rev_blame
    local old_path = file.old_path ~= "/dev/null" and file.old_path or file.path

    for _, hunk in ipairs(file.hunks) do
      for _, dl in ipairs(hunk.lines) do
        if dl.kind == "add" then
          local want = (exp.add or {})[dl.new_lnum]
          local got = maps.prov[dl.new_lnum]
          if not want then
            blame = blame or parse_blame(repo.run({ "blame", "-p", target, "--", file.path }))
            local b = blame[dl.new_lnum]
            want = b and { sha = b.sha, lnum = b.orig_lnum }
          end
          if not got or not want or got.sha ~= want.sha or got.lnum ~= want.lnum then
            fail(("add %s:%d composed %s, oracle %s")
              :format(file.path, dl.new_lnum, fmt(got), fmt(want)))
          end
        elseif dl.kind == "del" then
          local want = (exp.del or {})[dl.old_lnum]
          local got = maps.del_attr[dl.old_lnum]
          if not want then
            rev_blame = rev_blame or build_del_map(
              repo.run({ "blame", "-p", "--reverse", base .. ".." .. target, "--", old_path }),
              child)
            want = rev_blame[dl.old_lnum]
          end
          if not got or not want or got.sha ~= want.sha or got.lnum ~= want.lnum then
            fail(("del %s:%d composed %s, oracle %s")
              :format(old_path, dl.old_lnum, fmt(got), fmt(want)))
          end
        end
      end
    end
  end

  h.assert_true(name, bad == nil, bad)
  return composed
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "c1", files = { ["f.txt"] = "zero\none\ntwo\nTHREE\nfour\nfive\n" } },
    { msg = "c2", files = { ["f.txt"] = "zero\none\nTHREE\nfour\nfive\nsix\n" } },
    { msg = "c3", files = { ["f.txt"] = "zero\nONE\nTHREE\nfour\nfive\nsix\n" } },
  })
  oracle("oracle: linear edits", repo, repo.shas[1], repo.shas[4])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE .. "six\nseven\neight\nnine\nten\n" } },
    { msg = "c1", files = { ["f.txt"] = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" } },
    {
      msg = "rename+edit",
      rename = { ["f.txt"] = "g.txt" },
      files = { ["g.txt"] = "one\nTWO\nthree\nFOUR\nfive\nsix\nseven\nnine\nten\n" },
    },
  })
  oracle("oracle: rename", repo, repo.shas[1], repo.shas[3])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE, ["k.txt"] = "k\n" } },
    { msg = "delete", delete = { "f.txt" } },
    { msg = "re-add", files = { ["f.txt"] = "alpha\nbeta\n" } },
  })
  oracle("oracle: delete then re-add", repo, repo.shas[1], repo.shas[3])
end

do
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "add only", files = { ["f.txt"] = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n" } },
  })
  oracle("oracle: additions only", repo, repo.shas[1], repo.shas[2])
end

do
  -- A line moved within the file. Blame's -M/-C follows the move and credits
  -- the commit that originally wrote the line — here the base commit, i.e.
  -- outside the range, so it is useless as a review identity, and reverse blame
  -- likewise reports no deleter. Composition credits the in-range commit that
  -- moved it, which is the coordinate commit scope renders. That divergence is
  -- the intended correctness fix, so this fixture asserts composition.
  local repo = testutil.make_repo({
    { msg = "base", files = { ["f.txt"] = BASE } },
    { msg = "move five to the top", files = { ["f.txt"] = "five\none\ntwo\nthree\nfour\n" } },
  })
  local mover = repo.shas[2]
  oracle("oracle: moved line", repo, repo.shas[1], mover, {
    ["f.txt"] = {
      add = { [1] = { sha = mover, lnum = 1 } },
      del = { [5] = { sha = mover, lnum = 5 } },
    },
  })
  local c = check("moved line content check", repo, repo.shas[1], mover)
  h.assert_eq("mover owns the moved line", c["f.txt"].prov[1].sha, mover)
end

h.finish()
