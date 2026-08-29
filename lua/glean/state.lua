-- glean.state: the persisted ReviewStore — the single source of truth for what
-- the user has reviewed. It is keyed by **commit sha** (not branch), so a mark
-- left on a commit reappears in any branch/clone that contains that commit. On
-- disk it is sharded one JSON file per commit (`<dir>/<sha>.json`); in memory
-- it is the merged map { [sha] = { files = { [path] = { seen, seen_del, comments } } } }.
--
-- The single representation is a flat set of **seen line-identities**: every
-- changed diff line maps to one stable, serializable key, and seen-ness of any
-- display unit (hunk/file/commit/selection) is a fold over those identities.
-- There are three identity kinds (see `add_identity`/`del_identity`/
-- `wt_identity` below):
--   * committed add line → `(sha, post-image lnum)`, stored as the `seen` ranges
--     in the commit's immutable post-image coords;
--   * committed del line → `(remover_sha, pre-image lnum)`, stored as the
--     `seen_del` ranges in the commit's immutable parent coords;
--   * uncommitted (worktree) add/del line → the content hash of the line text,
--     stored as a flat set in the always-loaded `WORKTREE` shard.
-- `Store:is_seen`/`all_seen`/`mark`/`unmark` answer/mutate seen-ness uniformly
-- over identities; the range-math helpers below back the committed kinds and are
-- exercised directly by the Tier-1 tests. Per-line content addressing means
-- worktree mark/unmark is a pure set add/remove (no block coalescing).
local M = {}

-- The synthetic shard id under which all content-addressed comments live. It is
-- always loaded (regardless of which commits a review spans) so comments are
-- global per (repo, path, content) rather than tied to a base..target range.
M.COMMENTS_ID = "WORKTREE"

-- Merge a list of inclusive integer ranges into a minimal, sorted, non-adjacent
-- set. Adjacent ranges (e.. e+1) are coalesced.
function M.merge(ranges)
  local sorted = {}
  for _, r in ipairs(ranges) do
    sorted[#sorted + 1] = { r[1], r[2] }
  end
  table.sort(sorted, function(a, b)
    return a[1] < b[1]
  end)
  local out = {}
  for _, r in ipairs(sorted) do
    local last = out[#out]
    if last and r[1] <= last[2] + 1 then
      if r[2] > last[2] then
        last[2] = r[2]
      end
    else
      out[#out + 1] = { r[1], r[2] }
    end
  end
  return out
end

-- Add a range to a set, returning the merged result.
function M.add(ranges, range)
  local copy = {}
  for _, r in ipairs(ranges) do
    copy[#copy + 1] = { r[1], r[2] }
  end
  copy[#copy + 1] = { range[1], range[2] }
  return M.merge(copy)
end

-- Subtract a range from a set, returning the merged remainder.
function M.remove(ranges, range)
  local rs, re = range[1], range[2]
  local out = {}
  for _, r in ipairs(M.merge(ranges)) do
    if re < r[1] or rs > r[2] then
      out[#out + 1] = { r[1], r[2] }
    else
      if r[1] < rs then
        out[#out + 1] = { r[1], rs - 1 }
      end
      if r[2] > re then
        out[#out + 1] = { re + 1, r[2] }
      end
    end
  end
  return out
end

-- Does any range in the set contain the single line `lnum`?
function M.covers(ranges, lnum)
  for _, r in ipairs(ranges) do
    if lnum >= r[1] and lnum <= r[2] then
      return true
    end
  end
  return false
end

-- Is the whole inclusive range [s,e] covered by the set? After merging, this is
-- true iff a single range spans it.
function M.range_covered(ranges, range)
  local s, e = range[1], range[2]
  for _, r in ipairs(M.merge(ranges)) do
    if r[1] <= s and e <= r[2] then
      return true
    end
  end
  return false
end

-- ── Content-hash addressing (the floating "worktree" commit) ────────────────
-- Uncommitted changes live on a synthetic commit with no stable line numbers,
-- so each reviewed line is addressed by the **content hash** of its text. The
-- worktree shard stores a flat set of seen line hashes (per file); a line is
-- seen iff its current text hashes into that set. Per-line addressing makes
-- mark/unmark a pure set add/remove with no block-coalescing pass.

-- Content key for a single new-file line of text.
function M.line_hash(text)
  return vim.fn.sha256(text)
end

-- Pure re-anchoring helper. Given a block of `needles` (line texts), the
-- `haystack` sequence to search, a mapping from a haystack index to the line
-- number that index sits at (`lnum_of`), and the `anchor_lnum` the block was
-- authored against, return the start index of the closest consecutive match
-- (all-or-nothing), or nil if the block does not appear. Distance is measured
-- in `lnum_of` space, so callers choose the coordinate system the tiebreak
-- happens in (identity for plain ordinals, post-image line for a diff).
-- Ties on distance pick the lower index.
function M.resolve(needles, haystack, lnum_of, anchor_lnum)
  local content, diff_texts = needles, haystack
  local n = #content
  if n == 0 then
    return nil
  end
  local best, best_dist
  for i = 1, #diff_texts - n + 1 do
    local match = true
    for j = 1, n do
      if diff_texts[i + j - 1] ~= content[j] then
        match = false
        break
      end
    end
    if match then
      local l = lnum_of and lnum_of(i) or i
      local dist = l and math.abs(l - (anchor_lnum or 0)) or math.huge
      if not best_dist or dist < best_dist then
        best, best_dist = i, dist
      end
    end
  end
  return best
end

-- Split a list of new-file line numbers into maximal contiguous ascending runs.
local function contiguous_runs(lnums)
  local sorted = {}
  for _, l in ipairs(lnums) do
    sorted[#sorted + 1] = l
  end
  table.sort(sorted)
  local runs, cur, prev = {}, nil, nil
  for _, l in ipairs(sorted) do
    if l == prev then
    -- duplicate; skip
    elseif prev and l == prev + 1 then
      cur[#cur + 1] = l
      prev = l
    else
      cur = { l }
      runs[#runs + 1] = cur
      prev = l
    end
  end
  return runs
end

local Store = {}
Store.__index = Store

-- Create a store. `opts.dir` (injectable for tests) defaults to
-- stdpath("data")/glean. Data is empty until :load.
function M.new(opts)
  opts = opts or {}
  local dir = opts.dir or (vim.fn.stdpath("data") .. "/glean")
  return setmetatable({ dir = dir, data = {}, wt_shard = opts.wt_shard or M.COMMENTS_ID }, Store)
end

-- Map a shard id to a filesystem-safe filename. Most ids are commit shas or the
-- bare worktree sentinel, but branch-anchored worktree shards carry the branch
-- name (e.g. `WORKTREE/feature/foo`), so any character outside a safe set is
-- percent-encoded. The mapping is reversible and collision-free, keeping the
-- id↔filename relationship in this one place.
function Store:shard_path(sha)
  local safe = sha:gsub("[^%w._-]", function(ch)
    return string.format("%%%02X", ch:byte())
  end)
  return self.dir .. "/" .. safe .. ".json"
end

-- Read the shards for the given commit shas into `self.data`, replacing any
-- prior contents. Missing/unreadable/corrupt shards are silently skipped (a
-- never-reviewed commit simply has no entry). Returns self.data.
-- Read one shard from disk into `self.data[sha]` (no-op if missing/corrupt).
function Store:read_shard(sha)
  local path = self:shard_path(sha)
  if vim.fn.filereadable(path) ~= 1 then return end
  local content = table.concat(vim.fn.readfile(path), "\n")
  local ok, decoded = pcall(vim.json.decode, content)
  if ok and type(decoded) == "table" then
    decoded.files = decoded.files or {}
    M.migrate_shard(decoded)
    self.data[sha] = decoded
  end
end

-- Discard any pre-`seen-line-identity` worktree data. The legacy worktree shard
-- stored each file's `seen` as a *list of content blocks* (`{head, hash, n}`);
-- the current model stores a flat set of per-line content hashes
-- (`{ [hash] = true }`). The two are incompatible, and worktree marks are cheap
-- to recreate, so a legacy `seen` list is dropped rather than migrated in place.
function M.migrate_shard(decoded)
  M.migrate_comment_ids(decoded)
  -- Block seen-records (`seen_marks`) were superseded by reviewed baselines;
  -- they are abandoned rather than migrated (re-anchoring them by search is the
  -- lossy operation the baseline exists to delete).
  decoded.seen_marks = nil
  if not decoded.worktree or type(decoded.files) ~= "table" then
    return
  end
  for _, f in pairs(decoded.files) do
    -- Legacy block lists are array-like (`seen[1]` is a block table); the
    -- current per-line hash set is keyed by sha256 hex strings.
    if type(f.seen) == "table" and f.seen[1] ~= nil then
      f.seen = {}
    end
  end
end

-- Stamp ids onto comment records written before ids existed, in a deterministic
-- order (path, then authoring order), and seed `comment_seq` past the maximum so
-- freshly minted ids never collide with the backfilled ones.
function M.migrate_comment_ids(decoded)
  if type(decoded.comments) ~= "table" then return end
  local paths = {}
  for path in pairs(decoded.comments) do paths[#paths + 1] = path end
  table.sort(paths)
  local seq = decoded.comment_seq or 0
  for _, path in ipairs(paths) do
    for _, rec in ipairs(decoded.comments[path]) do
      if type(rec.id) == "number" then
        seq = math.max(seq, rec.id)
      end
    end
  end
  for _, path in ipairs(paths) do
    for _, rec in ipairs(decoded.comments[path]) do
      if type(rec.id) ~= "number" then
        seq = seq + 1
        rec.id = seq
      end
    end
  end
  decoded.comment_seq = seq
end

function Store:load(shas)
  self.data = {}
  local wanted = {}
  for _, sha in ipairs(shas) do
    wanted[sha] = true
    self:read_shard(sha)
  end
  -- Comments are content-addressed and global; their shard must be present for
  -- every review, even committed-range reviews that don't span it.
  if not wanted[self.wt_shard] then
    self:read_shard(self.wt_shard)
  end
  return self.data
end

-- Get (creating if absent) the in-memory slice for a commit.
function Store:commit(sha)
  local c = self.data[sha]
  if not c then
    c = { files = {} }
    self.data[sha] = c
  end
  return c
end

-- Get (creating if absent) the per-file record for a (commit, path).
function Store:file(sha, path)
  local c = self:commit(sha)
  local f = c.files[path]
  if not f then
    f = { seen = {}, comments = {} }
    c.files[path] = f
  end
  return f
end

-- Mark a new-file line range seen for (commit, path).
function Store:mark_seen(sha, path, range)
  local f = self:file(sha, path)
  f.seen = M.add(f.seen, range)
end

-- Unmark (remove) a new-file line range from (commit, path).
function Store:unmark_seen(sha, path, range)
  local f = self:file(sha, path)
  f.seen = M.remove(f.seen, range)
end

-- Seen ranges for (commit, path) (possibly empty).
function Store:seen_ranges(sha, path)
  local c = self.data[sha]
  local f = c and c.files and c.files[path]
  return (f and f.seen) or {}
end

-- Mark a pre-image (old-file) line range as a seen deletion for (commit, path).
-- Del identities live in `seen_del`, parallel to the add-line `seen` ranges, in
-- the commit's immutable parent coordinates.
function Store:mark_seen_del(sha, path, range)
  local f = self:file(sha, path)
  f.seen_del = M.add(f.seen_del or {}, range)
end

-- Unmark (remove) a pre-image line range from (commit, path)'s seen deletions.
function Store:unmark_seen_del(sha, path, range)
  local f = self:file(sha, path)
  f.seen_del = M.remove(f.seen_del or {}, range)
end

-- Seen deletion ranges (pre-image coords) for (commit, path) (possibly empty).
function Store:seen_del_ranges(sha, path)
  local c = self.data[sha]
  local f = c and c.files and c.files[path]
  return (f and f.seen_del) or {}
end

-- Append a comment to (commit, path) at a new-file line number. Comments are
-- stored keyed by the **string** form of new_lnum so they round-trip through
-- JSON (object keys are always strings); each line holds a list of texts.
function Store:add_comment(sha, path, new_lnum, text)
  local f = self:file(sha, path)
  local key = tostring(new_lnum)
  f.comments[key] = f.comments[key] or {}
  f.comments[key][#f.comments[key] + 1] = { text = text }
end

-- Remove the last comment matching `text` at (commit, path, new_lnum). Used to
-- reverse an add-comment action; no-op if none match.
function Store:remove_comment(sha, path, new_lnum, text)
  local c = self.data[sha]
  local f = c and c.files and c.files[path]
  local list = f and f.comments and f.comments[tostring(new_lnum)]
  if not list then return end
  for i = #list, 1, -1 do
    if list[i].text == text then
      table.remove(list, i)
      return
    end
  end
end

-- List of comment texts for (commit, path) at a new-file line number.
function Store:comments_at(sha, path, new_lnum)
  local c = self.data[sha]
  local f = c and c.files and c.files[path]
  local list = f and f.comments and f.comments[tostring(new_lnum)]
  return list or {}
end

-- Persist a single commit's shard (the unit a mark/comment edit rewrites).
function Store:save_commit(sha)
  vim.fn.mkdir(self.dir, "p")
  local slice = self.data[sha] or { files = {} }
  vim.fn.writefile({ vim.json.encode(slice) }, self:shard_path(sha))
end

-- ── Worktree (content-addressed) store methods ──────────────────────────────
-- The floating commit's slice carries `worktree = true` and a per-file record
-- of { seen = { [line_hash] = true }, comments = { [line_hash] = {{text}} } }.
-- `seen` is a flat set of content hashes: a line is seen iff its text's hash is
-- a key. Per-line addressing means mark/unmark is pure set add/remove.

function Store:wt_commit(id)
  local c = self.data[id]
  if not c then
    c = { worktree = true, files = {} }
    self.data[id] = c
  end
  c.worktree = true
  c.files = c.files or {}
  return c
end

function Store:wt_file(id, path)
  local c = self:wt_commit(id)
  local f = c.files[path]
  if not f then
    f = { seen = {}, comments = {} }
    c.files[path] = f
  end
  return f
end


local function wt_slice(store)
  local c = store.data[store.wt_shard]
  if not c then
    c = {}
    store.data[store.wt_shard] = c
  end
  return c
end

-- Prune the worktree shard when it carries no baselines, comments, files, or
-- sticky marks, so a fully-undone edit restores byte-identical JSON.
local function wt_prune(store)
  local c = store.data[store.wt_shard]
  if not c then return end
  local cm_empty = not c.comments or next(c.comments) == nil
  local f_empty = not c.files or next(c.files) == nil
  local st_empty = not c.sticky or next(c.sticky) == nil
  local bl_empty = not c.baselines or next(c.baselines) == nil
  if cm_empty and f_empty and st_empty and bl_empty then
    store.data[store.wt_shard] = nil
  end
end

-- ── Reviewed baselines (the uncommitted seen model) ────────────────────────
-- Uncommitted seen-ness is stored as a *reviewed baseline* R: the content of
-- the file the reviewer has signed off on, anchored to the content of the
-- review's tip-commit blob H. A displayed line's seen-ness is decided by
-- diffing (never by searching for stored text), so a record can neither resolve
-- at the wrong place nor outlive its subject. Because R only means anything
-- relative to the H it was reviewed against, the anchor is checked on every
-- read: a mismatch reads as "nothing reviewed" rather than as a diff against
-- stale content, so committing part of the work resets exactly the paths whose
-- base content moved.

-- Content key for a whole file's lines — the baseline anchor.
function M.content_hash(lines)
  return vim.fn.sha256(table.concat(lines or {}, "\n"))
end

-- The reviewed baseline lines for `path`, or nil when none is stored or the
-- stored anchor is not `base_hash`. A stale record is left in place (a later
-- read with its original hash still finds it); only a write replaces it.
function Store:baseline(path, base_hash)
  local c = self.data[self.wt_shard]
  local rec = c and c.baselines and c.baselines[path]
  if not rec or rec.base ~= base_hash then return nil end
  return rec.lines
end

-- Store `path`'s reviewed baseline. `lines` nil, or content-identical to the
-- base the hash names (nothing reviewed), prunes the record — and the worktree
-- slice when it then carries nothing else, so a mark fully undone restores
-- byte-identical JSON.
function Store:set_baseline(path, base_hash, lines)
  local prune = lines == nil or M.content_hash(lines) == base_hash
  local c = self.data[self.wt_shard]
  if not c then
    if prune then return end
    c = wt_slice(self)
  end
  if prune then
    if c.baselines then
      c.baselines[path] = nil
      if next(c.baselines) == nil then c.baselines = nil end
    end
  else
    c.baselines = c.baselines or {}
    c.baselines[path] = { base = base_hash, lines = lines }
  end
  wt_prune(self)
end


-- ── Content-addressed sticky seen-overrides ────────────────────────────────
-- A sticky mark exempts a line from the combined-scope display-demotion of short
-- seen runs: an explicit user mark records the line's content (path + content
-- hash) here so the line keeps rendering seen even when its store-seen run is too
-- short to survive demotion. Because the key is the content hash, a sticky mark
-- self-invalidates the moment the line's text changes (the hash stops matching),
-- which is exactly the "revisit previously reviewed code" behavior we want. This
-- set is a sibling of comments/seen-marks in the always-loaded worktree shard; it
-- never touches the seen `(sha, lnum)` model.

-- Record a line's content as a sticky seen-override for `path`.
function Store:add_sticky(path, text)
  local c = wt_slice(self)
  c.sticky = c.sticky or {}
  c.sticky[path] = c.sticky[path] or {}
  c.sticky[path][M.line_hash(text)] = true
end

-- Drop a line's sticky seen-override for `path`, pruning emptied containers so
-- the shard round-trips to byte-identical JSON.
function Store:remove_sticky(path, text)
  local c = self.data[self.wt_shard]
  local set = c and c.sticky and c.sticky[path]
  if not set then return end
  set[M.line_hash(text)] = nil
  if next(set) == nil then c.sticky[path] = nil end
  if next(c.sticky) == nil then c.sticky = nil end
  wt_prune(self)
end

-- Is a line's content a sticky seen-override for `path`?
function Store:is_sticky(path, text)
  local c = self.data[self.wt_shard]
  local set = c and c.sticky and c.sticky[path]
  return set ~= nil and set[M.line_hash(text)] == true
end

-- Append a comment anchored to a new-file line's content hash.
function Store:wt_add_comment(id, path, line_text, text)
  local f = self:wt_file(id, path)
  local key = M.line_hash(line_text)
  f.comments[key] = f.comments[key] or {}
  f.comments[key][#f.comments[key] + 1] = { text = text }
end

-- Remove the last worktree comment matching `text` at the line's content hash.
function Store:wt_remove_comment(id, path, line_text, text)
  local c = self.data[id]
  local f = c and c.files and c.files[path]
  local list = f and f.comments and f.comments[M.line_hash(line_text)]
  if not list then return end
  for i = #list, 1, -1 do
    if list[i].text == text then
      table.remove(list, i)
      return
    end
  end
end

-- Comments anchored to a new-file line's content (by hash).
function Store:wt_comments_for(id, path, line_text)
  local c = self.data[id]
  local f = c and c.files and c.files[path]
  local list = f and f.comments and f.comments[M.line_hash(line_text)]
  return list or {}
end

-- ── Content-addressed comments ──────────────────────────────────────────────
-- All comments live in the always-loaded COMMENTS_ID shard under a top-level
-- `comments` map keyed by path. Each record is { lnum, content = {...}, text,
-- origin }: `content` is the captured selection, one annotated entry per line
-- ({ text, kind, old_lnum? }); `lnum` the post-image authoring line (a tiebreak
-- / outdated fallback, never a coordinate); `text` the body; `origin` the
-- { sha, dirty } the selection was read from (provenance only).
-- Comments are re-anchored by content at render time, independent of any commit.

function Store:comments_commit()
  local c = self.data[self.wt_shard]
  if not c then
    c = { worktree = true, files = {} }
    self.data[self.wt_shard] = c
  end
  c.comments = c.comments or {}
  return c
end

-- Mint a fresh comment id. Ids are monotonic within a store and persisted
-- alongside the records (in `comment_seq`), so they survive a restart: an id
-- names a conversation, not its current location.
function Store:next_comment_id()
  local c = self:comments_commit()
  c.comment_seq = (c.comment_seq or 0) + 1
  return c.comment_seq
end

-- Append a comment record { anchor, content = {...}, text } for `path`. `id`
-- and `reply` are carried when present (an edit/undo replays the same record),
-- and a record without an id is stamped with a fresh one.
function Store:add_comment_record(path, record)
  local c = self:comments_commit()
  c.comments[path] = c.comments[path] or {}
  local list = c.comments[path]
  list[#list + 1] = {
    id = record.id or self:next_comment_id(),
    lnum = record.lnum,
    content = record.content,
    text = record.text,
    reply = record.reply,
    origin = record.origin,
  }
end

-- Two captured selections are equal when their annotated entries agree on text,
-- kind and (for deletions) pre-image line.
local function content_eq(a, b)
  if type(a) ~= "table" or type(b) ~= "table" or #a ~= #b then
    return false
  end
  for i = 1, #a do
    local x, y = a[i], b[i]
    if type(x) ~= "table" or type(y) ~= "table"
      or x.text ~= y.text or x.kind ~= y.kind or x.old_lnum ~= y.old_lnum then
      return false
    end
  end
  return true
end

-- Remove the last comment for `path` matching the given record by lnum,
-- content[] and text. Used to reverse an add; no-op if none match.
function Store:remove_comment_record(path, record)
  local c = self.data[self.wt_shard]
  local list = c and c.comments and c.comments[path]
  if not list then return end
  for i = #list, 1, -1 do
    local r = list[i]
    local by_id = record.id ~= nil and r.id == record.id
    if by_id then
      table.remove(list, i)
      return
    end
    if r.lnum == record.lnum and r.text == record.text and content_eq(r.content, record.content) then
      table.remove(list, i)
      return
    end
  end
end

-- Set (or clear, with nil) the agent reply on the record matching `record` for
-- `path`. Matches by id when the record carries one, else the same way
-- `remove_comment_record` does. Returns the stored record, or nil if unmatched.
function Store:set_comment_reply(path, record, reply)
  local c = self.data[self.wt_shard]
  local list = c and c.comments and c.comments[path]
  if not list then return nil end
  for i = #list, 1, -1 do
    local r = list[i]
    local match = record.id and r.id == record.id
      or (not record.id and r.lnum == record.lnum and r.text == record.text
        and content_eq(r.content, record.content))
    if match then
      r.reply = reply
      return r
    end
  end
  return nil
end

-- Every path with at least one comment record, sorted.
function Store:comment_paths()
  local c = self.data[self.wt_shard]
  local out = {}
  for path, list in pairs((c and c.comments) or {}) do
    if #list > 0 then out[#out + 1] = path end
  end
  table.sort(out)
  return out
end
-- All comment records for `path` (possibly empty).
function Store:comments_for(path)
  local c = self.data[self.wt_shard]
  return (c and c.comments and c.comments[path]) or {}
end

-- ── Addressing adapters ─────────────────────────────────────────────────────
-- Both adapters expose the same operations over **new-file line numbers**, so
-- the higher-level render/mark/comment flows stay identical. The range adapter
-- (real commits) delegates to the line-range helpers; the hash adapter
-- (floating commit) translates line numbers ↔ content via the supplied ordered
-- new-file line texts (`lines[new_lnum] = text`).

function M.range_adapter(store, sha, path)
  return {
    worktree = false,
    is_seen = function(lnum)
      return M.covers(store:seen_ranges(sha, path), lnum)
    end,
    mark = function(lnums)
      for _, run in ipairs(contiguous_runs(lnums)) do
        store:mark_seen(sha, path, { run[1], run[#run] })
      end
    end,
    unmark = function(lnums)
      for _, run in ipairs(contiguous_runs(lnums)) do
        store:unmark_seen(sha, path, { run[1], run[#run] })
      end
    end,
    range_covered = function(s, e)
      return M.range_covered(store:seen_ranges(sha, path), { s, e })
    end,
    add_comment = function(lnum, text)
      store:add_comment(sha, path, lnum, text)
    end,
    remove_comment = function(lnum, text)
      store:remove_comment(sha, path, lnum, text)
    end,
    comments_at = function(lnum)
      return store:comments_at(sha, path, lnum)
    end,
  }
end

-- ── Unified seen-identity API ───────────────────────────────────────────────
-- A line identity is a stable, serializable key for one changed diff line. It
-- is the single representation the higher layers fold over to derive seen-ness
-- of any display unit. Three kinds:
--   add: { kind = "add", sha, path, lnum }  -- committed add, post-image lnum
--   del: { kind = "del", sha, path, lnum }  -- committed del, pre-image lnum
--   wt:  { kind = "wt",  path, lnum, dkind } -- uncommitted line, positional:
--        an add's `lnum` is its work-tree line, a del's its tip-commit line
-- `sha == WORKTREE` add/del lines are represented as wt identities.

function M.add_identity(sha, path, lnum)
  return { kind = "add", sha = sha, path = path, lnum = lnum }
end

function M.del_identity(sha, path, lnum)
  return { kind = "del", sha = sha, path = path, lnum = lnum }
end

function M.wt_identity(path, lnum, dkind)
  return { kind = "wt", path = path, lnum = lnum, dkind = dkind }
end

-- Is a single line identity in the seen set?
function Store:is_seen(id)
  if id.kind == "add" then
    return M.covers(self:seen_ranges(id.sha, id.path), id.lnum)
  elseif id.kind == "del" then
    return M.covers(self:seen_del_ranges(id.sha, id.path), id.lnum)
  end
  -- `kind == "wt"` is decided against the path's reviewed baseline, which needs
  -- the tip-commit and work-tree contents the store has no view of, so it is
  -- never seen at the store layer.
  return false
end

-- Are all of the given identities seen? (a hunk/file/commit fold)
function Store:all_seen(ids)
  for _, id in ipairs(ids) do
    if not self:is_seen(id) then
      return false
    end
  end
  return true
end

-- Mark every given identity seen. Identities are grouped by owning shard so each
-- shard's seen set is updated once.
function Store:mark(ids)
  for _, id in ipairs(ids) do
    if id.kind == "add" then
      self:mark_seen(id.sha, id.path, { id.lnum, id.lnum })
    elseif id.kind == "del" then
      self:mark_seen_del(id.sha, id.path, { id.lnum, id.lnum })
    end
    -- wt identities advance the reviewed baseline, written by the Session.
  end
end

-- Drop a (commit, path) file record when it carries no seen state and no
-- comments, so that marking then unmarking the same lines restores the shard to
-- byte-identical JSON (the mark/unmark identity invariant).
local function prune_file(store, sha, path)
  local c = store.data[sha]
  local f = c and c.files and c.files[path]
  if not f then
    return
  end
  local seen_empty = not f.seen or next(f.seen) == nil
  local del_empty = not f.seen_del or next(f.seen_del) == nil
  local comments_empty = not f.comments or next(f.comments) == nil
  if seen_empty and del_empty and comments_empty then
    c.files[path] = nil
  end
end

-- Unmark every given identity, pruning emptied file records.
function Store:unmark(ids)
  for _, id in ipairs(ids) do
    if id.kind == "add" then
      self:unmark_seen(id.sha, id.path, { id.lnum, id.lnum })
      prune_file(self, id.sha, id.path)
    elseif id.kind == "del" then
      self:unmark_seen_del(id.sha, id.path, { id.lnum, id.lnum })
      prune_file(self, id.sha, id.path)
    end
    -- wt identities retreat the reviewed baseline, written by the Session.
  end
end

return M
