# Objective and Context

> I want to create a programmatic interface that magenta can use to interact with a glean review via the lua tooling. This should allow it to list comments, and respond to comments. We should also create a skill in ~/src/dotfiles/magenta-skills/ that explains to magenta how to use lua to exercise this API.

> I think we also need to extend the comment data type to support agent comments. Let's just have a singular one that the agent can override — so one user comment that the agent cannot edit, and one agent comment, per user comment.

Magenta can execute arbitrary lua in the host neovim (`nvim_exec_lua`). Glean already holds everything needed — the review store and a live `Session` — but nothing is reachable from outside the module: `sessions` / `buffers` are file-local tables (`init.lua:111`) and the comment surface is all `Session:` methods driven by cursor rows.

Key entities:

- comment record — `{ anchor:int, content:string[], text:string }`, stored per path in the always-loaded worktree shard (`state.lua:517 add_comment_record`, `538 remove_comment_record`, `552 comments_for`). Content-addressed: `content` is the diff-line text block captured at authoring time; `anchor` is only a tiebreak/fallback ordinal. This plan extends the record with one optional field, `reply:string?` — the agent's response, at most one per user comment.
- re-anchoring — `state.resolve(content, anchor, diff_texts)` (`state.lua:121`) finds the current location; `Session:resolve_comments(file)` (`init.lua:955`) does this per file and yields `by_ord[display_ordinal] = { {path, anchor, content, text, outdated} }`.
- `Session:comment_file_pairs()` (`init.lua:990`) enumerates every exact/display file pair, so comments in whitespace-hidden files stay discoverable — this is the enumeration the API wants.
- `emit_comment` (`init.lua:1159`) renders a record's `text` as rows carrying the comment identity; it grows a second block for `reply`.
- mutations go through `Session:perform{ kind="comment", op="add"|"remove"|"edit", ... }` (`init.lua:2909`, applied at `2109`), which gives undo and persists via `store:save_commit`.

Files:

- `lua/glean/init.lua` — session registry, Session methods, comment rendering, `M.open`.
- `lua/glean/state.lua` — the persisted store and comment records.
- `lua/glean/api.lua` — **new**: the flat, row-free programmatic surface.
- `lua/glean/api_test.lua` — **new**: headless suite (injected git runner, temp state dir).
- `~/src/dotfiles/magenta-skills/glean-review/skill.md` — **new**: the agent-facing skill.

# Design

A new module `glean.api` is the only thing external callers touch. It is a thin, stringly-typed adapter over an existing `Session`: it never re-implements anchoring, rendering or persistence, it just reuses `resolve_comments` and `perform`.

Ownership. A comment record has exactly two slots: `text`, owned by the human and never written by the API, and `reply`, owned by the agent and freely overwritten. The authority boundary lives in the data rather than in convention — the agent cannot lose the human's words, and re-running an agent over a review idempotently replaces its own answers instead of piling up duplicates. `reply = nil` means "not yet answered", which is also the query the agent uses to find its work.

Session identity. Ids only ever have to be resolvable inside the running neovim process, so they are process-local counters rather than anything derived from repo/base/target — short to type, unambiguous when several repos are open at once, and free of escaping problems (a repo path in an id would be long and would collide with the buffer-name mangling `review_title` already does to slashes). Each session gets `g1`, `g2`, … at construction from a module-level counter, and `review_title` (`init.lua:174`) prefixes it into the buffer name: `Glean:g2 glean main [origin∕main..dirty]`. The agent normally arrives via text pasted out of the review buffer, which carries that name, so it reads the id straight off the paste. `M.sessions()` returns `{ {id, repo, buf, base, target, scope, session} }` built from the existing `sessions`/`buffers` tables. `api.session(opts)` resolves `opts.session` (an id, also accepting a buffer number), else the single live session, else errors listing the available ids with their repo and range so the agent can pick. Reopening the same diff reuses the buffer and so keeps its id; ids are not reused after a buffer is wiped. Rationale for never conjuring a headless session: magenta should answer exactly what the human is looking at.

Buffer name. While `review_title` is being touched, its `[<range>]` suffix gets abbreviated: `range_identifier` (`init.lua:169`) interpolates whatever refs it was given, so a PR or branch review shows two 40-char oids. A ref that is a full hex sha renders as its first 8 chars (`8df5247a..09997456`); symbolic refs are left alone. This is display-only — `buffer_key`, the store and every lookup keep the full oids.

Comment identity. Comments are persisted (worktree shard, per path) and outlive the neovim process, so unlike session ids theirs must be stable across restarts — an agent told "answer comment 7" must find the same comment tomorrow. So the id is a **stored field on the record**, not derived and not process-local: `Store:next_comment_id()` mints a monotonic integer from a `comment_seq` counter kept in the same shard, and `add_comment_record` stamps it. It is independent of `path`/`anchor`/`content`/`text`, so a comment keeps its id when the human edits its body or when it re-anchors to a new line — the id names the conversation, not its current location. The id is **rendered in the buffer** on the comment's first row (`[7] > text`, its own highlight group), so a pasted snippet carries the session id in the buffer name and the comment id in the body — the agent can address any comment from a paste alone. Ids are unique per store (per repo + branch shard); every call that names a comment is qualified by the session id and errors on an unknown id — never a silent no-op. Alternative rejected: hashing the record's content, which is stable across restarts but changes whenever the human edits the comment and is far too long to render inline.

Listing. `api.comments(opts)` walks `comment_file_pairs()`, calls `resolve_comments(exact)`, and flattens to a list of plain tables: `{ id, path, lnum, side, text, reply, content, outdated, code }` where `lnum`/`side` come from the resolved display diff line (post-image lnum for adds/context, pre-image for dels) and `code` is the anchored source text. `opts.path` filters; `opts.unanswered` keeps only `reply == nil`. Order is deterministic: file order, then ordinal, then authoring order.

Replying. `api.reply(id, text)` sets the parent record's `reply`, replacing any previous one. `Store:set_comment_reply(path, record, reply)` is the store primitive (matching a record the same way `remove_comment_record` does); the session drives it with a new `op = "reply"` action carrying `old_reply`/`reply`, so undo restores the previous answer and the existing `save_commit` persistence path is unchanged. `emit_comment` renders the reply as an indented block beneath the comment body with its own highlight group (`GleanCommentReply`), so a glance distinguishes agent text from human text. Alternatives rejected: a sibling record sharing the parent's anchor (no ownership boundary, replies accumulate) and appending to the parent's `text` (mutates the human's words and the comment id).

Schema. `reply` and `id` are new fields on an existing record shape, so old shards still load; `M.migrate_shard` gains one case: records without an `id` are stamped in list order and `comment_seq` is seeded past the maximum, so a store written before this change gets stable ids on first load and keeps them from the next save on. `add_comment_record` copies fields explicitly, so it must be extended to carry both new fields or they are silently dropped on every write.

Wire format. The agent talks to lua over `nvim_exec_lua`, which round-trips values through JSON: it cannot hold a lua object between calls. So the API's every argument and every returned field is a string or number, `api.session` (which does return a `Session`) is internal, and there is no handle, cursor or iterator to keep. Each call is self-contained — identify by `(session, id)`, act, get plain data back.

Scope. The agent can read everything and write only `reply` — there is no `add` and no `delete`. Deleting would let it destroy the human's comment, which the ownership rule exists to prevent, and authoring would blur "the human's question" with "the agent's answer". If the agent has something to say that is not an answer, it says it in a reply. The human keeps the only authoring and deleting keymaps, in the buffer.

Surface. A comment id is unique only within its store (repo + branch shard), so every comment-addressing call is qualified by the session id — the pair `(session, id)` is the address, and both halves come out of a single pasted snippet. `session` may be `nil` when exactly one review is open.

- `api.sessions()` → `{ id, repo, base, target, scope, title }` per open review
- `api.comments(session, opts)` → the list above (`opts.path`, `opts.unanswered`)
- `api.reply(session, id, text)` → set/overwrite the agent reply
- `api.unreply(session, id)` → clear it

Every mutation calls `session:render()`, so the human watches the agent's replies land live.

Invariants:

- The API never writes a record's `text`; a human-authored comment is never altered by the agent. `reply` is the only field the agent may write.
- A comment carries at most one reply; replying twice replaces.
- Every id the agent needs — session and comment — is visible in the rendered buffer, so a
- Everything crossing the API boundary is JSON-serializable; no lua object is ever handed to a
  caller, so no call depends on state carried over from a previous one.
  paste out of the review is a sufficient address.
- The API never writes to the store directly; every mutation is a `Session:perform` action, so it lands in the undo stack and persists through the normal `save_commit` path.
- Listing is read-only and must not perturb collapse state, cursor, or the render generation.
- `api.comments` reports comments in files hidden by whitespace mode (via `comment_file_pairs`), flagged `outdated` when their content block no longer matches.

# Stages

## reply field — DONE

- Goal: a comment record can carry an agent reply that round-trips to disk and renders.
- Work (done): `id` and `reply` on the record plus the `comment_seq` counter and its migration
  (`M.migrate_comment_ids`, called from `migrate_shard`), `Store:next_comment_id` /
  `Store:set_comment_reply`, `add_comment_record` carrying/minting the new fields,
  `resolve_comments` + `collect_comments` surfacing them, `emit_comment` and the summary
  section rendering the `[id]` token (`GleanCommentId`) and the `↳` reply block
  (`GleanCommentReply`), and the `op = "reply"` / `"unreply"` action pair with undo
  (`Session:set_comment_reply`).
- Tests (done): `state_test.lua` covers id minting/monotonicity, reply round-trip through
  save/reload, replace-not-accumulate, clearing, unknown-id no-op, and the legacy-shard
  backfill (ids in path/list order, stable on a second load, `comment_seq` seeded past max).
  `init_test.lua` covers the rendered `[id]` token, the rendered reply row, undo back through
  the previous reply and to unanswered, and id/reply survival across a text edit.

Decisions/deviations:

- Every existing comment action (`remove`, `edit`, the visual batch delete) now carries `id`
  and `reply` in its record, so undo of a delete or an edit restores the *same* id and reply
  rather than minting a new one — `add_comment_record` mints only when the record has no id.
- `set_comment_reply` matches by `id` when the record has one, falling back to the
  anchor/content/text match `remove_comment_record` uses (for pre-id records mid-session).
- Existing render assertions that matched a bare comment body were updated for the `[id] `
  prefix.

## session accessor and listing — DONE

- Goal: `require("glean.api").comments()` returns every comment in the open review with a stable id, path, current line, text and reply.
- Tests (`api_test.lua`, fake git runner + temp state dir, `M.open{open_window=false}`):
  - With comments on two files, `comments()` returns them in file/ordinal order with correct `path`/`lnum`/`text`.
  - A comment whose anchored content changed in the diff comes back `outdated = true`.
  - Comment ids are stable across repeated `comments()` calls, across replying, across a
    refresh, and across reopening the session from the same state dir; they appear verbatim in
    the rendered buffer.
  - Two sessions on different repos get distinct ids, and each resolves by its id.
  - A review of two full oids names its buffer with 8-char shas, while a branch review's
    symbolic refs are unchanged and `buffer_key` still uses the full oids.
  - `opts.unanswered` returns exactly the unreplied comments.
  - With no session open, every entry point errors with a message naming the fix; with two sessions and no `session`, the error lists both candidates with their repo and range.

Decisions/deviations:

- Session ids are minted per *buffer key* (`session_ids[key]`, cleared on wipeout) rather than
  per Session object, so the refresh/reopen path that replaces a Session keeps the id.
- `M.live_sessions()` (init.lua) is the registry accessor; `api.sessions()` is the descriptive,
  JSON-only projection over it. `api.session(id)` takes the id (or a buffer number) positionally
  rather than an opts table, matching the `(session, ...)` shape of the other entry points.
- `api.comments` walks `comment_file_pairs()` and re-anchors with `state.resolve` against the
  exact file directly (the same computation `collect_comments` does) instead of
  `resolve_comments`, because it wants the canonical diff line's `lnum`/`side`, not a display
  ordinal, and must work for pairs whose display file is hidden. `M.flatten_diff_lines` is
  exported from init so nothing is re-implemented.
- Entries carry both `content` (the captured block, a list) and `code` (the same block joined),
  so a caller can use either shape.
- `review_title` gained an `id` parameter; the two title assertions in `init_test.lua` were
  updated for the `Glean:<id> <repo> …` prefix and the 8-char oids.

## mutations — DONE

- Goal: `reply` and `unreply` work by `(session, id)` and are visible in the buffer immediately.
- Work (done): `api.reply(session, id, text)` / `api.unreply(session, id)` plus a private
  `find_record(session, id)` that walks `comment_file_pairs()` and errors on an unknown id.
  Both delegate to the existing `Session:set_comment_reply`, which performs the undoable
  `reply` action and re-renders.
- Tests (done, `api_test.lua`):
  - `reply` surfaces on the next `comments()` and in the rendered buffer; `text` and `id` unchanged.
  - Replying twice replaces rather than accumulates.
  - `Session:undo()` after api mutations walks back through the previous reply to unanswered.
  - `unreply` clears; mutations persist across a wipe + reopen from the same state dir.
  - Unknown id and empty reply text both error; the surface exposes no `add`/`edit`/`remove`/`delete`.

Decisions/deviations:

- `api.reply` rejects a non-string or empty reply rather than silently clearing; clearing is
  `api.unreply`, so the two intents can't be confused by a JSON round-trip dropping a value.
- `find_record` returns a copy of the stored record extended with its `path`, which is exactly
  the shape `Session:set_comment_reply` expects — no new store primitive was needed.

## skill — DONE

- Goal: magenta discovers and drives the API without reading glean's source.
- Content: `~/src/dotfiles/magenta-skills/glean-review/skill.md` with frontmatter (`name: glean-review`, description scoped to "reviewing and responding to glean review comments"), a short model of comments and the text/reply ownership split, and — most importantly — how to recover the session id from the pasted buffer name (`Glean:g2 ...`) and the comment id from the pasted `[3]` token, with copy-pasteable `nvim_lua` snippets for each entry point plus the "no session open" recovery.
- Tests (done): manual — a headless script opened a real review (fake-free: a temp repo with
  the git runner), then ran `sessions`, `comments` (with `unanswered`), `reply`, `unreply` and
  both error paths, and the returned shapes were checked against the skill text.

Decisions/deviations:

- Corrections found by the manual run and folded into the skill: a comment row renders as
  `💬 [7] text` (not `[7] > text`), and `sessions().title` is the raw buffer name, which can
  carry a directory prefix — the id is the `g<N>` after `Glean:`.
- `~/src/dotfiles/nix/magenta-skills.nix` gained `glean-review` to its skill list, so home
  manager symlinks it into `~/.claude/skills` (skills are listed explicitly there, not globbed).
- The skill states the read-only boundary explicitly (no add/edit/delete) and tells the agent
  to ask the human rather than opening a review itself.
