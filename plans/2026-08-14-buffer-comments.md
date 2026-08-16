# Objective and Context

> I want to consider how we can expand the glean comment functionality, to let it not be tied so much to the glean buffer, but instead make it possible to leave comments, and see comments in any file.

> ok, so the thing we store needs to be resolvable against both the diff view and the file view. We're going to be creating comments by selecting a line or visual mode in the diff view or the file.

> So I think we can capture:
>
> - actual content of the file. These are the selected added lines in the diff view, or the literal file content in the file view.
> - deleted lines (when the line or visual selection in diff view contains deleted lines)
> - anchor line (in the file coordinate system)
> - anchor line (in the diff coordinate system)

> when displaying the comments in diff mode, the logic stays basically as-is. We use the diff anchor and content to display comments, we fall back to labeling "outdated" at the anchor position if the diff content.

> In particular, I want comments left in glean to show up in the files, and vice versa.
>
> So we will persist an array of lines that was selected, with each line annotated as added or deleted.
>
> - added lines are _file content_ so we should be able to match against added lines against the literal content of the file.
> - In the diff context, we can use the combination of added and removed lines.
>
> note that the +/- symbols at the head of the line have been moved to the sidebar, so the diff lines don't need to be amended... the diff displays lines as they appear in the file.

## Entities

- **Comment record** (`state.lua`, `WORKTREE` shard, `comments[path]` list). Today: `{ id, anchor, content = { text... }, text, reply }` where `anchor` is a flattened-diff ordinal and `content` a bare array of line bodies. This plan replaces both fields' meaning (see Design). No migration — legacy records are dumped when they misbehave.
- **`state.resolve(content, anchor, texts)`** (state.lua:121-142) — pure. Scans `texts` for a consecutive, all-or-nothing match of `content`, ties broken by `|i - anchor|`, lower index wins. The search space is arbitrary; only the callers make it diff-specific.
- **`Store`** (state.lua:170-176) — `M.new{ dir, wt_shard }`; `Store:load(shas)` always loads the `WORKTREE`/`COMMENTS_ID` shard (state.lua:254-265). Comment methods: `add_comment_record(path, record)`, `remove_comment_record(path, record)`, `set_comment_reply(path, record, reply)`, `comments_for(path)`, `next_comment_id()`, `save_commit(sha)`.
- **`Session`** (init.lua) — owns a `Store`; `refresh_model` (init.lua:3816-3850) **replaces** `self.store` with a freshly loaded one on every rebuild. `M.repo_state_dir(git)` (init.lua:166+) derives the per-repo store dir from `Git:common_dir()`.
- **`DiffLine`** (diff.lua:13-16, built at diff.lua:100-116) — `{ kind, text, old_lnum, new_lnum }`. `text` is the body with the `+`/`-`/` ` marker stripped, i.e. literally the file's line. `new_lnum` is set on `add`/`context` only; `old_lnum` on `del`/`context` only.
- **`flatten_diff_lines(file)`** (init.lua:826) — concatenates every hunk's `lines`; the sequence all diff-side resolution runs against.
- **`Session:resolve_comments`** (init.lua:983), **`collect_comments`** (init.lua:1053), **`comment_file_pairs`** (init.lua:1019) — the inline render, the summary section, and the file enumeration behind both.
- **`Session:comment_target`** (init.lua:3057) / **`visual_comment_target`** (init.lua:3072) — capture a row / contiguous row run as an authoring target.
- **`Session:open_comment_editor`** (init.lua:3227-3263) — the ephemeral markdown split. Depends on `Session` only for `self.win`.
- **`Git`** (git.lua) — `M.new{ repo_root, run }`, `M.discover_repo_root(path)`, `Git:common_dir()`. No absolute-to-repo-relative helper exists.

## Files

- `lua/glean/diff.lua` — parser; gains a post-image position on `del` lines.
- `lua/glean/state.lua` — the store; record shape and the resolution primitive.
- `lua/glean/init.lua` — session, renderer, keymaps, authoring.
- `lua/glean/git.lua` — repo root / common dir; gains `relpath`.
- `lua/glean/api.lua` — flat JSON surface for agents.
- `lua/glean/comments.lua` — **new**: repo-global store registry, the two projections, the shared editor.
- `lua/glean/overlay.lua` — **new**: comment rendering and authoring in ordinary file buffers.
- `skills/glean-review/skill.md`, `README.md` — docs.

# Design

## One record, two projections

A comment is a selection of lines. In the diff view that selection may mix added, deleted and context lines; in a file view it is plain file lines. The record captures the selection **annotated**, and each view derives the sequence it can search:

```lua
{
  id, lnum,
  content = {
    { text = "...", kind = "add" },
    { text = "...", kind = "del", old_lnum = 42 },
    { text = "...", kind = "context" },
  },
  text, reply,
  origin = { sha = "abc123", dirty = false },
}
```

- **diff projection** — every entry's `text`, in order. Matched against `flatten_diff_lines` texts. This is the same sequence stored today, so the diff view's behaviour is preserved.
- **file projection** — entries with `kind ~= "del"`, in order. Matched against the file's lines.

`origin` records **which version of the file the selection was read from** — the provenance of `content` and `lnum`. Nothing in this plan reads it; it exists so future display work can do better than content matching alone (e.g. re-diffing the origin blob against the current one to migrate an outdated comment, or telling "the reviewer saw an older version" apart from "the text changed"). It is also reported to agents, who benefit from knowing the reviewer was looking at commit X — possibly with uncommitted edits — rather than at whatever the file says now.

Determining it:

- **commit scope** — the commit whose file the row belongs to; `{ sha = M.WORKTREE, dirty = true }` (init.lua:43) for rows in the synthetic worktree commit.
- **combined scope** — the last commit in the composed span that touches this path, with `dirty = true` only if the path also has uncommitted changes in the span (`self.worktree` on and a worktree file entry exists, via `Session:file_for_path`). A clean path resolves to the plain commit sha.
- **file overlay** — `{ sha = M.WORKTREE, dirty = true }` when the buffer differs from HEAD for that path, else HEAD's sha.

`dirty` is deliberately a boolean rather than a content hash: the worktree is not addressable, so the honest statement is "read from commit X plus uncommitted edits", and anything stronger would be a lie a moment later.

Both are contiguous runs by construction: `add` and `context` each advance `new_lnum` by one, `del` does not, so deleting the `del` entries from a contiguous diff run leaves a contiguous run of post-image lines. (Symmetrically, dropping `add` would give the pre-image run; not needed now.)

Because the `+`/`-` markers render in the sign column rather than in the text, `dl.text` is already the literal file line — the file projection is byte-identical to the file's content, with no fix-ups.

## One anchor, in post-image coordinates

`anchor` (a flattened-diff ordinal) is deleted. It is a position in a _rendering_, so it drifts whenever hunks change size and means nothing outside the diff it was authored against.

It is replaced by a record-level `lnum`: the post-image (new-file) line of the run's first non-del entry, or — for a del-only selection — the post-image line the deleted text sat immediately before. Every consumer converts _into_ this space rather than keeping its own coordinate:

- **file view**: candidates are buffer positions; a candidate's lnum is the position itself.
- **diff view**: candidates are positions in the flattened diff; a candidate's lnum is the `new_lnum` of the `DiffLine` there.

`resolve` therefore takes a position-to-lnum mapping instead of a bare ordinal:

```lua
state.resolve(texts_to_find, lines, lnum_of, anchor_lnum)  --> start_index | nil
```

`lnum` is a _hint_, never a coordinate with a fixed frame: it is the post-image line at authoring time, in whatever commit or worktree the author was looking at, and it drifts across commits. `content` is the identity; `lnum` only breaks ties between multiple matches and picks a fallback slot. It must never be displayed as "the line this comment is on" — the resolved position is.

Pre-image numbers live on the `del` entries that they actually describe, as `old_lnum`. They are scoped to those entries, usable as a secondary tiebreak when resolving against the very commit they were captured from, and never load-bearing.

To make `lnum` total, `diff.lua` records the current `new_lnum` counter on `del` lines as well (currently only `old_lnum` is set, diff.lua:107-110). This is the position the deletion occupies in the post-image — a real, well-defined coordinate that needs no sha.

## Three resolution states

Per record, per view:

1. **anchored** — the view's projection matches. Renders at the match.
2. **off-diff** (diff view only) — the diff projection misses, but the file projection matches the working-tree file at `path`. The comment is live and correctly located, just on lines this review does not touch. It renders in the **summary section only**, labelled with its file line; `<CR>` opens the file there instead of expanding a hunk.
3. **outdated** — neither matches. Rendered with the existing `(outdated)` tag at the fallback slot: in the diff view, the row whose `new_lnum` is nearest `lnum` (better than today's clamped ordinal — it stays sensible as the diff grows or shrinks); in the file view, `clamp(lnum, 1, #lines)`.

A record can be anchored in one view and outdated in the other. That is a normal condition, not staleness.

Matching stays all-or-nothing over the whole projection: a five-line comment whose third line changed is fully outdated, not partially anchored. Preserved deliberately — a partial match would silently move a comment onto lines it was not written about.

## The summary section must cover every comment

`comment_file_pairs` (init.lua:1019-1050) enumerates diff files only, so a comment on a file the review does not touch would be invisible in glean. The summary instead walks the **union** of the diff paths and every path in `store:comments_for`; paths with no diff entry get a summary group with no display counterpart.

`collect_comments` needs the working-tree text of a path to test state 2. It reads `repo_root .. "/" .. path` (the existing pattern at init.lua:3476), memoized per render, skipped when the file is absent.

Summary entries gain `state = "diff" | "file" | "outdated"` and, for `"file"`, the resolved line. `api.comments` surfaces the same field.

## Store sharing without a lifecycle refactor

`Session` recreates its `Store` on every `refresh_model`, so an overlay cannot borrow one. `comments.lua` keeps a process-wide registry keyed by state dir:

- `comments.store(dir)` — memoized `Store` with the `WORKTREE` shard loaded (`store:load({})` suffices).
- every mutation writes, calls `save_commit(COMMENTS_ID)`, then fires `User GleanCommentsChanged` with `{ dir, path }`.
- `comments.invalidate(dir)` drops the memoized store.

Sessions keep their own store (they need the commit shards) but fire the same event on comment mutations and listen for it, re-reading the `WORKTREE` shard and re-rendering. The on-disk shard stays the single serialization point; the event is cheap because it is one small JSON file.

## Overlay: display

The file surface is modelled on diagnostics, not on the glean buffer. A glean buffer is read-only and can afford to own the screen; a file buffer is the user's editing surface and must stay legible while typing.

- **Sign column** — `💬` on each anchored line, a distinct highlight for outdated, a count when several records resolve to one line.
- **EOL virtual text** — the first line of the body, truncated and dimmed. Enough to know what a comment says without moving the cursor.
- **Float on demand** — full body plus any agent reply, opened by a mapping on the cursor line, in the manner of `vim.diagnostic.open_float`.
- **`virt_lines` only behind an explicit toggle** — inline bodies are right in a read-only diff and wrong in an editing buffer: they shift everything below down visually, fight with `zz` / `H` / `L`, and make screen-position jumps unreliable.
- **Multi-line records** — `line_hl_group` across the resolved run, so the extent is visible.
- **Loclist / quickfix dump** — the buffer's comments, or the repo's. This is the summary section's equivalent outside glean, and it comes for free.

Highlights reuse `GleanComment`, `GleanCommentId`, `GleanCommentReply`. Records whose file projection is empty (del-only) are skipped entirely.

## Overlay: anchoring

The common case is not the user typing. It is an **agent writing the file on disk** and the buffer reloading — via `autoread`/`:checktime`, or `:e`. A reload replaces the buffer's contents and drops its extmarks. So position is never tracked; it is always recomputed by content resolution, on every event:

- `BufReadPost`, `FileChangedShellPost`, `BufWritePost`, `GleanCommentsChanged` → resolve every record for the path against the buffer's lines, clear the namespace, re-stamp.
- When a resolve lands a record at a different line than its stored `lnum`, persist the new `lnum` immediately. Only on change, so the store write is rare.

Extmarks are the _rendering_ mechanism — signs, EOL text, `virt_lines` — and nothing more. They are not asked to remember anything between renders, which removes a whole class of "the mark drifted but the record didn't" bugs and makes the user-edit and agent-write paths literally the same code.

Not `TextChanged`: a full scan per record on every keystroke, to keep positions live during typing that will be resolved correctly the moment the buffer is written anyway. Being briefly stale mid-edit costs far less than that scan and the flicker it causes.

Cost is fine: a handful of records per file, each an O(lines × record length) scan, on events that already touch the whole file.

If the commented lines vanish — deleted by the user or rewritten by the agent — the record goes outdated and keeps the last `lnum` it resolved to, which is where you would want to look for it.

## Overlay: gating

`BufReadPost` fires for every file in the editor, so the handler must reduce to a hash lookup: a per-repo set of commented paths, derived from the store and refreshed on `GleanCommentsChanged`. No comments for this path → return before touching anything. No namespace, no buffer-local state, no autocmds, no mappings.

## Overlay: controls

A file buffer is `modifiable` and every single-letter key is spoken for, so glean's own `c` / `dd` / `i` / `e` bindings cannot carry over. The overlay ships `<Plug>` mappings and **installs no default mappings at all**; `M.config.overlay_keymaps` may define a prefix for users who want the defaults wired for them. Each is a clean no-op with a notify outside a repo.

- `(glean-comment)` — normal and visual; captures the line or the visual run and opens the shared ephemeral editor.
- `(glean-comment-show)` — float for the cursor line's comments.
- `(glean-comment-edit)` / `(glean-comment-delete)` — act on the cursor line's comments, `vim.ui.select` when there is more than one.
- `(glean-comment-reply)` — the human's side of the agent conversation.
- `(glean-comment-next)` / `(glean-comment-prev)` — jump by resolved position.
- `(glean-comment-toggle)` — inline bodies versus signs only.

Commands hang off the existing `:Glean` dispatcher (init.lua:4788-4819, alongside `log` / `prs` / `pr` / `branch`) rather than adding new top-level names:

- `:Glean comment` — author on the cursor line; `:'<,'>Glean comment` on a range, which needs `range = true` added to the command definition.
- `:Glean comments` — populates the quickfix list with every comment in the repo, resolved to its current file and line. One list, no buffer-scoped variant: filtering by file is what `:cfilter` and the quickfix window are for.

Del-only records, which have no file position, are listed at their `lnum` with an `(outdated)` marker rather than omitted.

Both are ordinary file-buffer commands, unrelated to whether a review is open. The dispatcher's subcommand list is worth pulling out into a table with a `complete` function while we are in there — it currently has none, and it is about to grow.

Authoring reuses the ephemeral editor, extracted from `Session` as `comments.open_editor(win, initial, on_submit)`.

## Overlay: undo layered over the buffer's undo

Neovim has no undo hook — there is no `UndoPre`/`UndoPost` autocmd (confirmed: `getcompletion("Undo", "event")` is empty on 0.12), no API to push a custom undo entry, and `on_bytes` cannot tell an undo from an edit. A comment mutation changes no text, so it cannot occupy a slot in the buffer's undo tree, and it must not: comment state is not a function of text state.

Instead the overlay keeps its own stack **layered on top of** the buffer's, using the same action shape as `Session:perform` (`{ kind, op, ... }` with an apply/revert pair) so the two share the mechanism:

- `u` and `<C-r>` are mapped buffer-locally wherever the overlay is active, and **fall through** when the glean stack is empty: `vim.cmd("undo")` / `vim.cmd("redo")`. The mapping is static, not installed and removed as the stack fills and empties — dynamic installation races with the very keypress that empties it.
- The stacks are wiped on a novel text edit, detected by caching `vim.fn.undotree().seq_last` per buffer and comparing on `TextChanged`/`TextChangedI`: `seq_last` grows only when a new state is created, whereas undo, redo, `g-` and `:earlier` move `seq_cur` and leave `seq_last` alone. That is an unambiguous discriminator, so no interleaving is needed.
- Consequences, accepted: comment operations always undo before text operations regardless of chronology; a count clamps to the glean stack rather than splitting across both; and `:undo`, `:undo 42`, `g-`, `:earlier` bypass the mapping and do plain buffer undo, leaving the glean stack untouched.
- `vim.cmd("undo")` rather than `feedkeys`, so there is no remap recursion and no dot-repeat interference.

This makes one rule true across the whole plugin, including the glean buffer where `u` already drives the action stack: **`u` undoes glean actions first, then text.**

## Interfaces

```lua
-- lua/glean/diff.lua  (changed)
-- del lines now carry the post-image position they occupy:
{ kind = "del", text, old_lnum, new_lnum }

-- lua/glean/state.lua  (changed)
-- Find `needles` in `haystack`; among matches pick the one whose lnum, via
-- `lnum_of(index)`, is nearest `anchor_lnum`. Returns the 1-based start or nil.
function M.resolve(needles, haystack, lnum_of, anchor_lnum)

-- lua/glean/comments.lua  (new)
M.COMMENTS_ID = state.COMMENTS_ID

function M.diff_projection(record)   --> { text... }              -- all entries
function M.file_projection(record)   --> { text... }              -- kind ~= "del"

-- Resolve one record against a text sequence. `lnum_of` maps an index in
-- `lines` to a post-image line number (identity for a file buffer).
-- --> { lnum = <resolved or fallback>, outdated = bool }
function M.locate(record, lines, lnum_of)

function M.context(bufnr)            --> { repo_root, dir } | nil -- memoized per repo
function M.store(dir)                --> Store                    -- WORKTREE shard only
function M.invalidate(dir)
function M.for_path(dir, path)       --> { record... }

function M.add(dir, path, record)    --> id
function M.remove(dir, path, record)
function M.set_reply(dir, path, record, reply)

function M.open_editor(win, initial, on_submit)

-- lua/glean/git.lua  (new)
function M.relpath(repo_root, abs)   --> string | nil             -- nil if outside

-- lua/glean/overlay.lua  (new)
function M.setup(cfg)
function M.refresh(bufnr)                       -- cold-start resolve + stamp
function M.toggle(bufnr)                        -- inline bodies vs signs only
function M.show(bufnr, lnum)                    -- float for a line's comments
function M.add_at(bufnr, lnum)
function M.add_range(bufnr, srow, erow)
function M.edit_at(bufnr, lnum)
function M.delete_at(bufnr, lnum)
function M.reply_at(bufnr, lnum)
function M.jump(bufnr, direction)               -- 1 | -1
function M.quickfix(dir)                        -- every comment in the repo
function M.undo(bufnr)                          -- falls through to vim.cmd("undo")
function M.redo(bufnr)
```

## Invariants

- `content` is the identity of a comment. `lnum` and `old_lnum` are hints that only break ties and choose fallback slots; no correctness may depend on them.
- Both projections of a record are contiguous runs. Authoring must never produce a record that violates this (capture stops at the first ordinal gap, as `visual_comment_target` already does).
- No field used for _resolution_ is meaningful only relative to a specific sha. `old_lnum` is the sole pre-image number and is confined to the entry it describes. `origin` names a sha by design, but nothing may come to depend on that sha still existing.
- `origin` is provenance, not a coordinate: it says where `content` and `lnum` were read from, and must never gate whether a comment renders.
- Every comment record for the repo appears in the summary section exactly once, whether or not its path or lines are part of the review.
- A record whose file projection is empty never renders in a file overlay.
- Matching is all-or-nothing over the whole projection.
- A record written by one surface renders in the other, without reopening either.
- The on-disk `WORKTREE` shard is the single serialization point; no comment exists only in one of two in-memory stores.
- A comment's position is always the result of resolving its content against the current buffer. Extmarks render it and never store it; no state survives a re-render.
- `u` undoes glean actions before text, in the glean buffer and in a file buffer alike. The overlay's stack never interleaves with the buffer's undo tree and is wiped by a novel text edit.
- The overlay installs no default mappings. Nothing about glean's presence changes a key's meaning in a buffer with no comments.

# Stages

## record shape and resolution primitive — DONE

- Goal: records carry annotated `content` and a post-image `lnum`; `resolve` tiebreaks in post-image space; the diff view behaves exactly as before.
- Work: set `new_lnum` on del lines in `diff.lua`; change `state.resolve` to `(needles, haystack, lnum_of, anchor_lnum)`; drop `anchor` from the record and add `lnum` + per-entry `kind`/`old_lnum`; create `comments.lua` with `diff_projection`, `file_projection`, `locate`; update `comment_target` / `visual_comment_target` to capture annotations, the post-image anchor and `origin`; update `resolve_comments` and `collect_comments` to pass `new_lnum` as `lnum_of`.
- Tests (`diff_test.lua`, `state_test.lua`, `comments_test.lua` — all pure):
  - A del line reports the post-image position it occupies, and a del run inside a hunk reports the same position for each of its lines.
  - `resolve` picks the match nearest the anchor _lnum_, not the nearest index, when the two disagree — i.e. a candidate early in the diff but late in the file loses.
  - Round-trip: a record with mixed `kind`s and `old_lnum`s survives save/load.
  - The two projections of a mixed selection are the expected sequences, and the file projection of a del-only selection is empty.
- Done. Deviations / decisions:
  - `comments.locate(record, lines, lnum_of, projection)` takes a fourth argument (`"diff"`, the default, or `"file"`) rather than inferring the projection; the caller always knows which space it is searching. It returns `{ index, lnum, outdated }` — `index` is the match start in `lines`, `lnum` the resolved (or fallback) post-image line.
  - `state.resolve` keeps identity tiebreaking when `lnum_of` is nil, so the seen-block callers (which still anchor by flattened ordinal) just swap argument order.
  - `state.content_eq` now compares annotated entries by `text`/`kind`/`old_lnum`, since `content` is no longer a list of strings.
  - Summary entries carry both `lnum` (the record's hint) and `display_lnum` (the resolved diff line, what the `L%d` tag shows); the summary sorts by the resolved line. `comment_row` matches on `lnum` instead of the ordinal.
  - `api.comments` derives `side` from the record's annotations (del-only → `old`) and reports `origin` verbatim, as the later api stage anticipates; the rest of that stage is untouched.
  - The outdated fallback in the diff view is already the nearest-`new_lnum` row (`nearest_ord`), which the summary stage will reuse.
  - No migration: legacy records (bare-string `content`, `anchor`) simply stop matching and render outdated, as the plan allows.
- Tests (`init_test.lua`): a comment authored on a glean row records the right `lnum` and annotations for add / context / del / mixed-visual selections; existing inline-render and outdated tests still pass with the ordinal gone.
  - `origin` round-trips and is ignored by every resolution path: a record with a bogus `origin` resolves identically to one without.
  - `origin` is stamped correctly per scope — commit scope stamps the row's commit; a worktree row stamps `{ sha = WORKTREE, dirty = true }`; combined scope stamps the last commit touching the path with `dirty = false`, and flips to `dirty = true` once that path is dirtied.

## summary section covers every comment — DONE

- Goal: every comment in the repo is listed in the summary, including comments on unchanged lines and on files outside the review, with the three states distinguished.
- Work: widen `comment_file_pairs` to the union of diff paths and store paths; add the memoized working-tree read and the state-2 attempt to `collect_comments`; render the `"file"` state with its line; `<CR>` on such a row opens the file there; carry `state` through `api.comments`.
- Tests (`init_test.lua`):
  - A comment on an unchanged line of a reviewed file: absent from the diff body, present in the summary as `"file"` with the right line.
  - A comment on a file entirely outside the review still gets a summary group.
  - `<CR>` on an off-diff summary row opens the file buffer at that line.
  - Content in neither diff nor file is `"outdated"`, at the row whose `new_lnum` is nearest `lnum` — check it lands sensibly after hunks above it grow.
  - Summary counts and rollups include off-diff comments.
- Done. Deviations / decisions:
  - `Session:comment_file_pairs` now wraps the old body, renamed
    `Session:diff_file_pairs`; store-only paths are appended as `{ path = p }`
    pairs with no `exact`/`display`, and `collect_comments` / `api.comments`
    tolerate a pathless pair (empty flattened diff). `Store:comment_paths()` is
    new in `state.lua`.
  - Off-diff resolution reads the working tree through `Session:wt_file_lines`,
    memoized per render (cleared in `build()` next to `_wt_seen`).
  - Summary entries gain `state` ("diff" | "file" | "outdated") and `file_lnum`;
    `outdated` now means "not resolvable anywhere" (a file-state record is no
    longer flagged outdated). `hidden` is unchanged. Rank order for the
    per-record best entry: diff > hidden > file > outdated.
  - The file state renders as `file L%d` in the summary; `<CR>` routes through
    the new `Session:open_comment_file(path, lnum)`, which edits the working-tree
    file in the glean window and clamps the cursor.
  - `api.comments` reports `state` and, for the file state, the file line as
    `lnum`; it derives both from `collect_comments` keyed by record id rather
    than duplicating the working-tree read.
  - Tests: one new block at the end of `init_test.lua` (own hermetic repo)
    covering unchanged-line and outside-the-review comments, the outdated
    fallback landing in the diff, summary counts, the `<CR>`-opens-the-file path
    and the api's `state`/`lnum`.

## read-only overlay — DONE

- Goal: opening any file in the repo shows its comments as signs and EOL text, with a float on demand; no authoring yet.
- Work: `overlay.lua` cold-start resolve, sign / EOL / float / `virt_lines`-toggle rendering, the commented-path gate, the autocmd group, resolve on every buffer event, the `:Glean comments` quickfix.
- Tests (`overlay_test.lua`, headless, real buffers + temp state dir; drive it through real `:edit` and buffer writes rather than calling `refresh`, since the integration is the hard part):
  - Records written straight into a store appear as signs at the resolved line on open, with the body's first line as EOL text.
  - An external write plus a reload (`:checktime` after writing the file behind the buffer's back) re-resolves the comment to its new line and persists the moved `lnum` without the user ever writing the buffer.
  - Inserting lines above a comment and writing the buffer re-resolves it to the new line and persists the moved `lnum`.
  - A record that resolves to the same line triggers no store write.
  - A mixed-selection record anchors on its surviving non-del lines.
  - Deleting the commented text renders it outdated at the collapsed extmark position, and the write-back records that position.
  - A del-only record produces no extmarks.
  - A file with no comments creates no extmarks, no buffer-local state and no mappings.
  - The float shows the body and the agent reply; the `virt_lines` toggle adds and removes inline bodies without disturbing the signs.
- Done. Deviations / decisions:
  - The store registry lives in `comments.lua` as planned but is keyed by a
    **context** (`{ repo_root, dir, wt_shard }`), not a bare dir: the comment
    shard is branch-scoped (`glean.wt_shard`), so `M.store(ctx)` /
    `M.for_path(ctx, path)` / `M.persist(ctx, path)` all take the context.
    `M.context(bufnr)` memoizes the upward `.git` walk per directory and the
    context per (resolved) repo root, keyed through `vim.fn.resolve` so a
    symlinked root (`/var` → `/private/var`) hits one registration.
    `M.register(root, dir, wt_shard)` is the test/config seam.
  - `comments.persist` writes the shard and fires `GleanCommentsChanged` with
    `source = "registry"`; the overlay's listener skips `invalidate` for its own
    writes, since aliasing a stale in-memory store is worse than the re-read.
    (The session half of that event is stage 5.)
  - `git.relpath(repo_root, abs)` added, retrying against fully resolved paths.
  - Rendering: `💬` sign (`GleanComment`, or the new `GleanCommentOutdated` when
    every record on the line is outdated), EOL virt text `#id <first line>` with
    `(+N more)` for a shared line and an `(outdated)` suffix, the new
    `GleanCommentLine` across a multi-line run, and `virt_lines` bodies behind
    `overlay.toggle`. `overlay.show` builds its own float (body + `↳` reply),
    closed on the next `CursorMoved`/`BufLeave`/`InsertEnter`.
  - `:Glean comments` runs `overlay.quickfix()` then `copen`; the dispatcher was
    left as its if-chain (the table + completion refactor belongs with the rest
    of the command growth in stage 4).
  - No `<Plug>` mappings, no `u`/`<C-r>` handling and no authoring yet — stage 4.
  - Tests: `overlay_test.lua` (29 assertions), driven through real
    `:edit`/`:write`/`:checktime` against a hermetic repo with a registered
    temp state dir.

## authoring from any buffer — DONE

- Goal: leave, edit, reply to and delete comments from a normal file buffer, with a layered undo.
- Work: extract `open_editor` out of `Session`; the `<Plug>` set plus optional `overlay_keymaps` prefix; `:GleanComment`; the action-shaped overlay stack with `u`/`<C-r>` fallthrough and `undotree().seq_last` wipe detection.
- Tests:
  - Authoring in a file buffer produces `kind = "add"`-only content — never `del` — with the right `lnum`, `origin` and repo-relative path, persisted to disk.
  - A visual range captures the exact contiguous line texts.
  - Delete removes exactly one record when several resolve to the same line.
  - A buffer outside any repo is a clean no-op with a notify.
  - Undo: after a comment delete, `u` restores the comment and leaves the buffer text alone; a second `u` with an empty glean stack performs a real buffer undo; `<C-r>` mirrors both.
  - The stack is wiped by a novel edit but survives an undo/redo of buffer text — assert via `seq_last` staying put across `u`.
  - With no comments in the buffer, `u` is not mapped at all.
- Done. Deviations / decisions:
  - The mutation surface is `comments.apply(ctx, action, op)` / `comments.reverse(ctx, action)`
    — the same action shape and op vocabulary as `Session:apply_comment`, taking
    a context (not a bare dir, matching the stage-3 registry) and persisting +
    announcing through `comments.persist`. `overlay.add/remove/set_reply` from
    the plan's interface sketch are not separate entry points; the overlay's
    `perform` pushes an action and applies it.
  - `Store:remove_comment_record` now matches by `id` when the record carries
    one. The overlay resolves (and rewrites) `lnum` in place, so lnum+content
    matching alone could pick the wrong record of several on a line.
  - `Session:open_comment_editor` is a two-line delegate to
    `comments.open_editor(win, initial, on_submit)`; the body moved verbatim.
  - `<Plug>` mappings are installed globally in `overlay.setup`; `u`/`<C-r>` and
    the `TextChanged`/`TextChangedI` seq watcher are installed buffer-locally by
    `activate`, called from `refresh` the first time a buffer is found to carry
    comments — so an uncommented buffer really is untouched, and authoring into
    one wires it up on the spot.
  - `:Glean comment` (with `range = true` on the command) and a `complete`
    function listing the subcommands; the dispatcher body stayed an if-chain.
  - Provenance for a file-buffer selection is HEAD's sha with
    `dirty = buffer modified or the path is dirty per `git status --porcelain``.
  - Tests: the authoring half of `overlay_test.lua` works against its own
    committed `author.txt` so it is independent of what the rendering tests left
    behind (69 assertions in the suite).

## cross-surface sync

- Goal: a comment left in a file shows up in an open glean buffer and vice versa, without reopening.
- Work: the `GleanCommentsChanged` event, `comments.invalidate`, the session listener that re-reads the shard and re-renders, the overlay listener.
- Tests (`init_test.lua`):
  - With a session open, an overlay-authored comment whose content is in the diff renders in the session once the event fires.
  - The reverse updates an already-open file buffer.
  - Ids do not collide when both surfaces author into the same repo in sequence.
  - A session mutation followed by `u` is reflected in the overlay.

## api and docs

- Goal: agents can list and author comments with no review open.
- Work: session-free `api.comments{ repo, path }` and `api.add_comment{...}`; `api.reply` resolving ids through the repo store; session-scoped functions delegate. `api.comments` reports `state` and the resolved line, and derives `side` from the record's annotations rather than inspecting the resolved `DiffLine` (api.lua:60). It also reports `origin` verbatim, so an agent can distinguish a comment written against the current file from one written against an older version, and can fetch that blob itself when the two disagree. Update the skill and README.
- Tests (`api_test.lua`):
  - `comments` with no session open returns the repo's records.
  - `reply` by id works with no session open and persists.
  - Session-scoped and repo-scoped calls agree on ids, bodies and `side` for the same repo.
  - `origin` survives to the api output unchanged, including `dirty`.
