# Objective and Context

> I want to extend the api + skill to allow the agent to programmatically help me with reviews - to fetch hunks by commit and combined, to filter hunks by seen/unseen, and to toggle hunks as seen / unseen.
>
> Let's add an api method to query hunks. Provide the options of querying in commit-by-commit mode or combined mode. Allow a glob filter for files to include.
>
> The results should be given in a stable order.
>
> The results should be paged - so a default number of hunks is given, and an iteration cursor is returned. Querying with the cursor gives the following N chunks.

## Entities

- `Session` (`init.lua`) — a live review. Holds `scope` (`"combined"|"commits"`),
  `files` (raw base..target FileEntries), `commits` (Commit list, including the
  synthetic `M.WORKTREE`), `combined_files` (`compute_combined()`, `{path, kind,
  hunks, raw}`), and `store` (the persisted ReviewStore).
- `Hunk` (`diff.lua`) — `{ old_start, old_count, new_start, new_count, header,
  lines }`; `DiffLine` — `{ kind = "context"|"add"|"del", text, old_lnum,
  new_lnum }`. Hunks have **no** stable id today; the UI addresses them
  positionally via row-map targets (`{commit, file, hunk}` /`{cfile, hunk}`).
- Seen-ness (`init.lua` 540-760) — `Session:line_identity(dl, path, owner, ord)`
  folds a line to an identity (`add_identity(sha,path,lnum)` /
  `del_identity` / content-hashed `wt_identity`); `Session:changed_lines(hunk,
  path, owner, base_ord)` is the ordered identity list of a hunk's add/del lines;
  `Session:id_seen(id)`, `Session:ids_all_seen(ids)`, `Session:hunk_seen(...)`.
  `hunk_base_ords(file)` (file-local) gives each hunk's flattened ordinal base.
- Owner closures — `Session:commit_owner(commit)` (commits scope, no loading
  needed) and `Session:combined_owner(path)` (combined scope; returns an
  all-`nil` owner until `Session:load_lineage()` has populated `self._owner`,
  i.e. `owner_status(path) == "loaded"`).
- Mutation — `Session:perform({kind="seen", op="mark"|"unmark", ids, sticky})`
  then `Session:render()`. That is exactly what `Session:toggle_seen` (2699) and
  `Session:unmark_marker` (2921) do; `sticky` records (`{path, text}`, built by
  `Session:target_sticky`) are combined-scope only.

## Files

- `lua/glean/api.lua` — the flat JSON-only surface; where the new calls go.
- `lua/glean/init.lua` — Session; needs two small helpers (below).
- `lua/glean/api_test.lua` — Tier-3 tests over a real hermetic repo
  (`testutil.make_repo`) + `glean.open{ open_window = false, run = <repo runner> }`.
- `skills/glean-review/skill.md` — the agent-facing doc to extend.

# Design

Two new api calls, both pure adapters over what `Session` already computes.

`api.hunks(session, opts) -> { hunks = {...}, cursor = <string|nil>, total = <n> }`

- `opts.mode` — `"combined"` (default) or `"commits"`. **Independent of the
  session's own scope**: both projections are derivable from the model the
  session already holds. This needs one new helper,
  `Session:all_hunks(mode)`, which returns the ordered flat list of
  `{ key, mode, sha, path, file, hunk, index... }` entries:
  - `commits` mode: for each `self.commits[ci]` in order, each `commit.files[fi]`,
    each `file.hunks[hi]`, with `owner = commit_owner(commit)`.
  - `combined` mode: `self.combined_files = self.combined_files or
    self:compute_combined()`, `self:load_lineage()` (idempotent, pure Lua, no
    subprocess — safe to call even when `scope == "commits"`), then each
    `cf.hunks[hi]` with `owner = combined_owner(cf.path)`.
  This centralizes the "walk every hunk with its owner" logic that
  `progress_counts` and `each_target_hunk` each open-code, without disturbing
  them.
- Order is the index order above: commit order → file order → hunk order
  (combined: file order → hunk order). Deterministic and matches buffer order.
- `opts.path` — a glob (`"lua/**/*.lua"`). Implement with
  `vim.glob.to_lpeg(glob)` + `vim.lpeg.match` if available on the pinned nvim,
  otherwise `vim.regex(vim.fn.glob2regpat(glob))`; verify at implementation time
  and pick one, no new dependency.
- `opts.seen` — `true` / `false` / omitted. Uses `Session:hunk_seen` so the api
  and the buffer agree by construction. Note the display-only `min_seen_run`
  demotion is *not* consulted: the api reports the persisted model.
- Paging — `opts.limit` (default 20) and `opts.cursor`. The cursor is the
  **stable order key of the next hunk to emit**, not an offset: a zero-padded
  string `"%06d:%06d:%06d"` of the index triple (commits) or `"%06d:%06d"`
  (combined). Filtering and paging both run over the ordered index and emit
  hunks whose key `> cursor`, so a cursor stays meaningful across a re-render
  and degrades gracefully if a hunk disappeared. `cursor` in the result is the
  key of the last emitted hunk, or `nil` when the page was the last one.
- Each returned hunk is plain data (`ApiHunk` below), carrying its body as one
  `ApiLine` per diff line. `(hunk id, line i)` addresses exactly one diff line,
  which is the granularity the human has with a visual-mode mark.

`api.mark(session, sel, seen)` — the api mirror of what the human can do with
`m`: mark a whole hunk, or mark specific lines within one. `sel` is one
selector or a list of them; a selector is either a hunk id string (the whole
hunk, like `m` on a hunk header) or `{ id = <hunk id>, lines = { i, ... } }`
(those line indices only, like a visual-mode mark). `seen` defaults to `true`.

- Resolve each id against `Session:all_hunks(mode)` (the mode is encoded in the
  id's shape/prefix so the call is self-contained), error on an unknown id
  exactly like `find_record` does for comments.
- Fold each selector to identities: whole hunk → `Session:changed_lines(hunk,
  path, owner, base_ord)`; explicit `lines` → `Session:line_identity(hunk.lines[i],
  path, owner, base_ord + i)` per index, erroring on an out-of-range index and
  skipping (reporting) context/unowned lines that have no identity. Keep only ids
  whose current
  `id_seen` disagrees with the request (mirroring `toggle_seen`), gather sticky
  records for combined mode — `{path, text}` per *selected* add/del line, as
  `target_sticky` builds them, so a partial mark sticks only for the lines the
  agent chose — then a **single**
  `s:perform({kind="seen", op=..., ids=..., sticky=...})` + `s:render()` for the
  whole batch, so the agent's whole pass is one undo step.
- Returns `{ hunks = <#selectors applied>, lines = <#identities changed> }`.

## Interfaces

The codebase carries no `---@class` annotations, so these are written as
pseudo-types for the plan; the implementation documents them in prose comments
in the existing house style.

Ids and cursors (opaque to the caller, ordered by plain string `<`):

```
HunkId  = "c:<ci>:<fi>:<hi>"   -- commits mode, zero-padded %06d components
        | "b:<cfi>:<hi>"       -- combined mode
Cursor  = HunkId               -- the last hunk emitted on the previous page
```

The components are the positional indices the row-map targets already address
hunks by — `ci` = index into `session.commits`, `fi` = index into
`commit.files`, `hi` = index into `file.hunks`; `cfi` = index into
`session.combined_files`. Zero-padded so plain string comparison reproduces the
enumeration order.

They are therefore only valid for the current model: a refresh that adds a
commit or a file shifts them. That is acceptable because both consumers are
short-lived — a paging loop and an immediately following `mark` — and `mark`
re-resolves the id and errors when it is out of range, rather than marking the
wrong hunk. Each `ApiHunk` also reports `path`/`sha`/`header`, so an agent can
notice a shifted id.

```
```

`Session:all_hunks(mode)` — internal, the only place that walks both
projections. Returns a lua array (owners are closures, so this never crosses the
api boundary):

```
mode  = "combined" | "commits"
entry = {
  id     : HunkId,
  mode   : mode,
  sha    : string,        -- commits mode: the commit's sha, or glean.WORKTREE
                          -- combined mode: nil (a hunk has many owners)
  path   : string,
  file   : FileEntry,     -- commits: commit.files[fi]; combined: combined_files[cfi]
  hunk   : Hunk,
  owner  : fun(dl: DiffLine): string?, integer?,   -- commit_owner / combined_owner
  base   : integer,       -- hunk_base_ords(file)[hunk]
}
```

`api.hunks(session, opts)`:

```
opts = {
  mode   : "combined" | "commits" = "combined",
  path   : string?      -- glob, matched against the file path
  seen   : boolean?     -- nil = both
  limit  : integer      = 20
  cursor : Cursor?      -- emit hunks with id > cursor
}

-> {
  hunks  : ApiHunk[],
  cursor : Cursor?,   -- nil when this page was the last
  total  : integer,   -- hunks matching the filters, ignoring paging
}

ApiHunk = {
  id           : HunkId,
  mode         : "combined" | "commits",
  sha          : string?,   -- commits mode only; "WORKTREE" for the floating commit
  path         : string,
  kind         : "add" | "delete" | "modify" | "rename",
  header       : string,    -- the "@@ -a,b +c,d @@" line
  old_start    : integer, old_count : integer,
  new_start    : integer, new_count : integer,
  seen         : boolean,   -- Session:hunk_seen
  adds         : integer, dels : integer,
  unseen_lines : integer,   -- changed lines whose identity is not seen
  lines        : ApiLine[],
}

ApiLine = {
  i    : integer,   -- 1-based index into hunk.lines; the line address for mark()
  kind : "context" | "add" | "del",
  lnum : integer?,  -- new_lnum for add/context, old_lnum for del
  side : "new" | "old",
  text : string,    -- the line body, without the +/-/space marker
  seen : boolean,   -- false for context and unowned lines (they are unmarkable)
}
```

`api.mark(session, sel, seen)`:

```
Selector = HunkId                              -- the whole hunk
         | { id : HunkId, lines : integer[] }  -- those ApiLine.i values only

api.mark(session : string?, sel : Selector | Selector[], seen : boolean = true)
  -> { hunks : integer, lines : integer }
     -- hunks: selectors applied; lines: identities whose seen state actually flipped
```

Every field above is a string, number, boolean, or an array/map of those, so the
whole surface round-trips through JSON, as the `api.lua` header promises.

Invariants:

- The api never re-implements seen-ness: `hunk_seen`/`changed_lines`/`id_seen`
  stay the only definition, so api answers and buffer rendering can't diverge.
- Every value crossing the boundary is a string or number (JSON round-trip), as
  the module header promises.
- Mutations go through `Session:perform`, so they are undoable with `u`,
  persisted through the normal save path, and re-rendered live.
- Combined-mode identities require loaded ownership; `all_hunks("combined")`
  must call `load_lineage()` before reading owners, else every hunk silently
  reports unseen. Marking a hunk whose file is not loaded must error, not no-op.
- `mode = "commits"` on a combined-scope session (and vice versa) must work
  without mutating the session's own scope, `combined_files` caching aside.
- Paging with an unchanged review must enumerate every hunk exactly once.

# Stages

## enumerating hunks

- Goal: `Session:all_hunks(mode)` returns the ordered, owner-carrying flat hunk
  list for either mode, on a session of either scope, with ownership loaded.
- Tests (`init_test.lua` or `api_test.lua`, whichever holds Session-level tests):
  - On a 2-commit repo opened in `combined` scope, `all_hunks("commits")`
    enumerates each commit's hunks in commit order and each entry's `sha` is that
    commit's sha.
  - On a session opened in `commits` scope, `all_hunks("combined")` returns
    entries whose owners resolve — mark a line via the normal path and assert the
    index reports the hunk seen (i.e. lineage was loaded, not a nil owner).
  - A dirty work-tree review includes the WORKTREE commit's hunks in commits mode.

## api.hunks

- Goal: paged, filtered, stably-ordered hunk listing.
- Tests:
  - Full enumeration with `limit = 1` and cursor-following yields exactly the
    same ordered list as one unlimited call, with a `nil` cursor at the end.
  - `path` glob restricts to matching files (`"*.txt"` vs `"lua/**/*.lua"`,
    including a case that must *not* match a nested path).
  - Marking a hunk seen via the existing keymap/`Session` path flips its `seen`
    field and moves it between `{seen=true}` and `{seen=false}` result sets;
    `unseen_lines` drops to 0.
  - `lines` of a returned hunk reproduce the raw `git diff` body in order, with
    correct `kind`/`lnum`/`side` per line, and `header`/`new_start` matching it.
  - Marking a subset of a hunk's lines leaves the hunk `seen = false` while those
    lines report `seen = true` and `unseen_lines` shrinks by exactly that count.

## api.mark

- Goal: batch mark/unmark hunks as one undo step.
- Tests:
  - `mark(s, { id = h, lines = {2} })` marks exactly that line: the buffer
    renders it in a `✓ marked` marker (or as a demoted plain row under
    `min_seen_run`) while the rest of the hunk stays unseen — assert against the
    rendered buffer, since partial marking is where the render/model agreement is
    easiest to break.
  - `mark(s, id)` then `hunks{seen=true}` includes that hunk, and the buffer
    renders it in the seen section (assert against the rendered buffer lines, not
    just the store — this is the integration that matters).
  - `u` in the buffer (`Session:undo`) reverts a multi-hunk `mark` in one step.
  - Round trip: `mark` then `mark(..., false)` returns the review to its
    starting rendered state.
  - Unknown id, or a `lines` index outside the hunk, errors naming it;
    already-seen hunks are a
    no-op reporting `lines = 0`.

## skill + docs

- Goal: the agent can drive a review end to end from the skill alone.
- Update `skills/glean-review/skill.md` with a "hunks" section: the two calls,
  the id/cursor contract, the `(id, line i)` addressing for partial marks, the
  paging loop, the mode choice (combined = "what
  changed overall", commits = "review commit by commit"), and the rule that the
  agent marks hunks seen only when the human asks it to triage.
- Update `context.md`'s `api.lua` line to mention hunk query/marking.
