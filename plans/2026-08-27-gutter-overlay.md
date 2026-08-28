# Objective and Context

> I wonder if we could show, in the regular buffer, some decoration of the
> status of the buffer in our current glean session. Like in the left sidebar?
>
> I think right now we show git diff markers... I'd like to suppress these when
> a glean session is active, and show markers specific to the glean session
> instead.
>
> Ideally these would show added, removed, and edited lines - but also the seen
> status, so you could see within the actual file what's changed, and what's
> been marked.
>
> (clarification: the git diff markers come from another plugin — gitsigns.)

## Entities

- `Session` (`lua/glean/init.lua`) — the one live review. Module-level `current`,
  reachable as `require("glean").current_session()`. Relevant fields/methods:
  - `session.worktree` (bool) — target is `M.WORKTREE`, i.e. the review's
    post-image *is* the working tree.
  - `session.files` — raw combined-scope FileEntries (`{ path, kind, hunks }`),
    each hunk holding ordered `DiffLine`s with `kind` in `add|del|context` and
    `new_lnum` (post-image line; a del line carries the slot it was removed from).
  - `Session:combined_owner(path)` (550-577) → `fn(dl) -> sha, lnum`, per-line
    ownership by patch composition; the loader is async
    (`load_lineage`/`start_owner_loader`), so ownership may not be ready yet.
  - `Session:line_identity(dl, path, owner, ord)` (656-675) → identity, and
    `Session:id_seen(id)` (704) → bool. These are *the* definition of seen-ness;
    the gutter must reuse them rather than reimplement.
  - `hunk_base_ords(file)` — flattened ordinal base per hunk, needed because
    worktree identities resolve positionally.
- `state.lua` identity kinds: `add_identity(sha,path,lnum)`,
  `del_identity(sha,path,lnum)`, `wt_identity(path,text)`.
- `overlay.lua` — the existing precedent for decorating *ordinary file buffers*
  from glean state (own namespace, `refresh(bufnr)`, autocmd wiring, `<Plug>`
  maps, driven by a `User GleanCommentsChanged` event). The new gutter follows
  this shape exactly and is a sibling module, not a change to overlay.
- gitsigns public API (installed at `~/.local/share/nvim/lazy/gitsigns.nvim`):
  `require("gitsigns").detach(bufnr)` and `.attach(bufnr)`.

## Files

- `lua/glean/gutter.lua` — NEW. Projection + rendering + buffer lifecycle.
- `lua/glean/gutter_test.lua` — NEW. Headless tests for the pure projection.
- `lua/glean/init.lua` — expose `Session:file_status(path)`; fire a review-changed
  event; call `gutter.setup` from `M.setup`; refresh/teardown hooks.
- `lua/glean/overlay.lua` — unchanged (shares the file buffer; different namespace).
- `README.md`, `context.md` — document the feature and the new module.

# Design

A file buffer gets a second, gutter-only projection of the same model the review
buffer renders. It is derived, never stored: on every event that can change the
model or the seen set, we recompute `path -> {lnum -> mark}` from the live
session and re-stamp extmarks. No position tracking, no incremental diffing —
the same "recompute from the model" discipline overlay.lua uses for comments.

## Where the data comes from

Only the **combined scope**, and only when the session's target *is* the working
tree (`session.worktree`, i.e. `target == M.WORKTREE` — the live review). In that
configuration the combined view's post-image is by construction the buffer's
content, so a `new_lnum` is a gutter row directly, with no content resolution.
When the target is a commit (the post-image is a snapshot the buffer may have
moved past), or the buffer is `modified` since the last model refresh, or the
file is not in the session, the gutter paints nothing — a wrong marker in the
user's editing surface is worse than no marker.

## Classification

Per file, walk each hunk's `lines` and fold consecutive runs:

- a del/add block is coupled by the *existing* edit detection,
  `intraline.pair_lines(del_texts, add_texts)` — the order-preserving,
  similarity-scored pairing the combined buffer already uses for intra-line
  emphasis. Reusing it means "this looks like an edit" means the same thing in
  the gutter and in the review. A paired add row is `change`; an unpaired add
  (`add_unpaired`) is `add`; unpaired dels (`del_unpaired`) contribute a
  `del_below` flag on the nearest preceding post-image row.
- `pair_lines` is the expensive part (per-pair token alignment). The session
  already memoizes its results by block text in `self._intra_cache`
  (init.lua:1895, 1949-1954); `file_status` reads through that same cache, so
  a gutter repaint on an unchanged hunk does no alignment work.
- an `add` run with no preceding del → `add`.
- a `del` run with no following add → a `del_below` flag on the *previous*
  post-image row (or `del_above` on row 1 when the deletion is at the top of the
  file), rendering the standard "something was removed here" tick.

Seen-ness is per line, from `line_identity` + `id_seen`, using `combined_owner`
and the hunk's flattened ordinal base. For a `change`/`del_below` row the row is
seen iff *every* identity folded into it is seen, so a half-marked change never
reads as done. Display-only demotion (`min_seen_run`) is deliberately NOT
applied: it is a property of how a hunk looks inside the review buffer, not of
the model, and the gutter answers "is this line marked".

When ownership has not finished loading (`combined_owner` returns nil for
everything) we still paint kinds and treat every row as unseen; the loader's
completion fires a refresh.

## Rendering

One extmark per marked row in namespace `glean_gutter`, `sign_text` selected by
kind and `sign_hl_group` by (kind, seen). Shape carries the kind, colour carries
the seen status:

- add / change / del use `▎`, `▎`, `▁`
- colour comes from `sign_hl_group`: `GleanGutterAdd` / `GleanGutterChange` /
  `GleanGutterDelete` for unseen, and the `…Seen` variants for marked lines.
  Unseen link to `DiffAdd`/`DiffChange`/`DiffDelete`; seen link to `Comment`, so
  a marked line's glyph stays in place but greys out and unreviewed work is what
  draws the eye. All six are plain highlight groups a colourscheme can override.

## Suppressing the other plugin

Config `gutter.suppress` (default `"auto"`): on the first paint of a buffer we
detach the foreign provider and record that we did so; on session close (or when
the buffer leaves the session's file set) we reattach. `"auto"` handles gitsigns
by name; the option also accepts a `{ detach = fn(bufnr), attach = fn(bufnr) }`
table so a user on a different plugin wires their own, and `false` to leave the
other plugin alone. Detach/attach are wrapped in `pcall` — a missing or renamed
provider must never break the gutter.

## Triggers

A new `User GleanReviewChanged` autocmd event (data `{ id, dir }`) is fired by the
session on: model refresh completion, ownership-loader completion, and any seen
mutation (mark/unmark). `gutter.setup` subscribes to it and to `BufReadPost`,
`BufWinEnter`, `BufWritePost`, `TextChanged` (which clears, since the buffer has
diverged from the model until the next poll), plus the session teardown path.

## Interfaces

```lua
-- lua/glean/gutter.lua
--- kind: "add" | "change"; del_below: bool; seen: bool
--- @alias GleanGutterMark { kind: string?, del_below: boolean, seen: boolean }

--- Pure. `hunks` is a FileEntry's hunk list; `is_seen(dl, hunk, i)` answers
--- seen-ness for one diff line. Returns lnum -> mark in post-image coords.
function M.project(hunks, is_seen) end

--- Recompute and re-stamp `bufnr`. No-op when there is no live worktree
--- session, the buffer is not one of its files, or the buffer is modified.
function M.refresh(bufnr) end

--- Clear marks and restore the foreign provider for every buffer we touched.
function M.clear_all() end

function M.setup(cfg) end
```

```lua
-- lua/glean/init.lua
--- The gutter projection for one path in the combined scope, or nil when the
--- session is not worktree-targeted or does not carry the path.
function Session:file_status(path) end
```

```lua
M.config.gutter = {
  enabled = true,
  suppress = "auto", -- "auto" | false | { detach = fn, attach = fn }
}
```

## Invariants

- The gutter never paints a row it cannot prove: no marks unless
  `session.worktree` and `not vim.bo[bufnr].modified`.
- Seen-ness shown in the gutter is the *model's* seen-ness — the same
  `id_seen` the review buffer and the rollups use. Display-only demotion is
  not applied.
- A row folding several identities (a change row, a row with deletions below)
  is seen only if all of them are.
- The gutter owns its own namespace and never touches `glean_overlay`; a line
  can carry both a comment sign and a gutter sign (`signcolumn` may need
  `yes:2`, which we set only on windows showing a painted buffer, and restore).
- Every foreign provider we detach is reattached on teardown, on session close,
  and on `VimLeavePre`.
- Nothing here is persisted: the gutter is pure projection.

# Stages

## projection

**Status: done** (`lua/glean/gutter.lua`, `lua/glean/gutter_test.lua`).

Deviation: an unpaired del inside a block that *also* has added lines ticks the
block's last post-image row (`del_below`) rather than the context row above the
block — the deletion belongs to the edited region. Only a del run with no adds
at all falls back to the preceding context row (or `del_above` on row 1). A mark
is `{ kind, del_below, del_above, seen }`; `del_above` was added to the alias.

- Goal: `gutter.project` turns a file's hunks plus a seen predicate into the
  per-lnum mark map, correctly classifying add / change / deletion-tick and
  folding seen-ness. Pure, no nvim API, testable headless like `diff`/`intraline`.
- Tests (`gutter_test.lua`, hand-built hunk tables):
  - A pure addition run marks each added lnum `add`, and none of the context.
  - A del run immediately followed by an add run marks the add rows `change`,
    not `add`.
  - 3 dels similar to 1 add: the paired add row is `change` and carries
    `del_below` for the two dels `pair_lines` left unpaired.
  - A del run and an add run that are wholly dissimilar (below `pair_lines`'
    threshold) stay `add` rows plus a `del_below` tick — not `change`.
  - A trailing del run with no adds sets `del_below` on the preceding context
    row; a deletion at line 1 sets `del_above` on row 1.
  - A change row whose add is seen but whose paired del is not is `seen=false`.
  - Two hunks in one file both project into the same map without collision.

## session projection

**Status: done** (`Session:file_status` in `lua/glean/init.lua`,
`lua/glean/file_status_test.lua`).

Deviations:
- The `_intra_cache` read-through described above does not apply: that cache
  memoizes `intraline.refine`, not `pair_lines`, so `file_status` calls
  `gutter.project` (and hence `pair_lines`) directly. If repaint cost shows up,
  a separate pairing cache is the fix.
- `file_status` also returns nil for a path the session does not carry.

- Goal: `Session:file_status(path)` wires `combined_owner` + `line_identity` +
  `id_seen` (with correct flattened ordinals) into `gutter.project`, and returns
  nil for non-worktree sessions or unknown paths.
- Tests (`file_status_test.lua`, fake git runner as in the existing suites):
  - [x] A work-tree session over a fixture repo reports the changed lnums as
    unseen (change / add rows, context untouched); after marking the file seen
    the same lnums report `seen=true`.
  - [x] A commit-targeted session returns nil; so does an unknown path.
  - [x] Ordinals: the uncommitted line ("five") marked via a block record is
    reported seen — the part that is easy to get wrong, since worktree
    identities resolve positionally.

## rendering and lifecycle

**Status: done** (rendering half of `lua/glean/gutter.lua`, buffer tests at the
end of `lua/glean/gutter_test.lua`, wiring in `lua/glean/init.lua`).

Deviations:
- `GleanReviewChanged` is fired from `Session:notify_changed`, called from
  `Session:render` (both exits) rather than from three separate sites: render is
  the one funnel every model refresh, ownership-loader completion and seen
  mutation already passes through.
- The event carries no path, so the handler refreshes every loaded, named
  buffer; `refresh` is cheap for a buffer with no session/path.
- `signcolumn` is left alone (no `yes:2` management): overlay's comment signs set
  the precedent of not touching window options, and a mixed comment/gutter line
  is a user configuration concern. A row that has both a kind and a deletion tick
  renders the kind glyph; the tick glyph only appears on rows with no kind.
- `gutter.setup_highlights` is called from init's `setup_highlights`, so the six
  groups follow `ColorScheme` like the rest.
- `gutter.lua` requires `glean.init` (not `glean`) to reach `current_session`,
  matching `api.lua`: the two paths are distinct modules and only `glean.init`
  holds the live session.
- Suppression of the foreign provider is stage 4; nothing detaches yet.

- Goal: opening a reviewed file while a session is live paints the signs; marking
  a hunk seen in the review repaints the file buffer; closing the review clears.
- Tests (`gutter_test.lua`, real buffers headless — `overlay_test.lua` is the
  precedent for driving nvim buffers in a test):
  - [x] After `refresh`, the extmarks in the gutter namespace sit on exactly the
    projected lnums with the expected `sign_hl_group`.
  - [x] Marking seen and firing `GleanReviewChanged` flips those marks to the
    seen highlight without changing their rows.
  - [x] Editing the buffer (`modified`) clears the marks; reverting repaints.
  - [x] `close_current` clears every painted buffer.
  - [x] A file not in the session is untouched.

## suppression and config

- Goal: gitsigns is detached from painted buffers and reattached on teardown;
  the behaviour is configurable and never fatal.
- Tests:
  - With an injected fake provider (`{ detach, attach }` recording calls),
    painting a buffer detaches once (not per refresh) and `clear_all` reattaches
    exactly the buffers detached.
  - `suppress = false` never calls the provider.
  - A provider whose `detach` throws still leaves the gutter painted.

## docs

- Goal: README section (keymaps/config table entry, highlight groups) and a
  `gutter.lua` line in `context.md`'s layout list.
- Tests: `nvim -l lua/glean/run_tests.lua` green.
