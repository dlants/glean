# Objective and Context

User request: "write up a plan to restore all functionality. this port should be functionally identical. In the plan, tell the agent to refer to the previous implementation in the git history (link the last commit that had the change + files) for reference"

The TypeScript port (`plans/2026-09-22-typescript-port.md`) moved glean to a node backend, but it dropped several features in stages 4–7. The goal here is **exact behavioural parity** with the Lua implementation, built on the node architecture and following the rules in `.github/instructions/` (a thin Lua side, async git with timeouts, bounded main-thread work, branded and union types).

## Reference implementation (read this first)

The last commit that has the complete Lua implementation is **`0f31363514329f02720d93e7348bd0e89a69cbd7`**, the parent of the cutover commit `f3c9ecb`. It is the spec. Read files with `git show 0f31363:<path>`, and don't guess behaviour. Where this plan and the old code disagree, the old code wins.

- `lua/glean/init.lua`: the `:Glean` command dispatch (near the end of `M.setup`), `open`/`open_dirty`/`open_branch`/`open_pr`/`open_log`/`open_prs`, the review buffer keymaps (search `local function map`), LogView/PrView, jump/diffsplit/sticky float, whitespace toggle and the comment editor.
- `lua/glean/overlay.lua`: the comment overlay in file buffers, `:Glean comment`, and `:Glean comments` (quickfix).
- `lua/glean/api.lua`: the agent api, including `M.session(id)`.
- `lua/glean/git.lua`, `state.lua`, `gutter.lua`, `comments.lua`, `bufundo.lua`: supporting behaviour.
- `README.md` and `doc/glean.txt`: user-facing docs for every feature and keymap. Restore both to match.
- Tests, which are the behavioural spec to port: `init_test.lua` (4.3k lines, mostly unported), `overlay_test.lua`, `api_test.lua` (the title/oid/symbolic-ref and one-review-at-a-time cases), `reload_test.lua` (diffsplit/jump, the `:e` hard reset, and the per-whitespace-mode history cache), `async_test.lua`, `file_status_test.lua`, `suspend_test.lua`.
- `plans/2026-09-22-typescript-port.md`, lines ~195–242: the list of what was deferred and why.

## Current node layout

See `context.md`. Features plug into `node/glean.ts` (command dispatch), `lua/glean/node.lua` (keymaps become `action(buf, {...})` rpcnotify), `node/render/*` (pure planners and render), `node/session/session.ts`, `node/view/view.ts` and `node/api/api.ts`.

# Design

Port each missing feature the same way the port handled existing ones:
- Keymaps in Lua send one `Action` variant.
- Behaviour lives in node as pure planners plus session mutations.
- Rendering goes through `Frame`.
- Any extra buffers or windows (log, PR list, diffsplit, sticky float, comment editor) are created and written by node through the nvim API.
- Lua only keeps what must run in-process: `vim.ui.input` and editor prompts, which forward their result as one notify.

GitHub access (PRs) goes through an injectable `gh` runner, matching the old `opts.gh_run`, with a timeout like the `GitRunner`.

## Missing surface (must all exist when done)

- `:Glean` subcommands:
  - bare (dirty review), `<base>`, `<base> <target>`, a PR number or URL, `branch [name]`, `pr <n|url>`, `prs`, `log`;
  - `jump`, `comment` (with range), `comments`;
  - plus the existing `toggle-mark` and `toggle-gutter`.
  - Completion list as in the old code.
- Review buffer keymaps:
  - `M`, `U`, `c` (n and x), `i`/`e`, `dd`, `dc`, visual `d`, `ac` (x and o);
  - `]c`/`[c`/`]f`/`[f` (n and x);
  - `<CR>` as jump, with the existing reveal-comment behaviour folded in exactly as the old code did;
  - `D` (diffsplit), `W` (whitespace toggle), `q`.
  - Check every mapping against the old `map(...)` block and resolve any conflict with the current node mappings in favour of the old behaviour.
- LogView (`<CR>` n and x, `]p` load more, `q`) and PrView (`<CR>`, `]p`/`[p`, `q`).
- The sticky float, `hunk_indent`/`hunk_indent_delay_ms`, the whitespace mode toggle, and `default_base`.
- Every config key the old `setup` accepted, with the same defaults: `default_base`, `gutter`, `hunk_indent`, `hunk_indent_delay_ms`, `ignore_whitespace`, `min_seen_run`, `overlay`.
- File-buffer comment overlay (display, add, add over a range, quickfix listing) per `overlay.lua`.
- Agent api: `session(id)`, buffer titles for abbreviated oids and symbolic refs, and one review at a time. Existing api results must match the old JSON shapes.

## Invariants

- The persisted store format stays compatible with both the Lua version and the current node version.
- Nothing added here blocks nvim. `gh` and git calls are async with timeouts. The PR list, log paging and diffsplit content loading go through node.
- Behaviour matches the old Lua tests. Each old test case is either ported or listed in the plan with a reason it cannot apply (for example, it asserts a Lua internal). "Deferred" is not an acceptable reason.

# Stages

## Review targets: base/target, branch, PR, log, PR list
- Goal: every `:Glean` open form works, including LogView and PrView with paging, and the review-buffer title and naming match the old ones.
- Tests: port the matching `init_test` and `api_test` cases (commit-range reviews, branch, PR arg parsing via `is_pr_arg`/`github_pr_repo`/`github_remote_repo`, a fake `gh` runner, log selection including visual `<CR>`, paging). A driver test runs `:Glean <base> <target>` and `:Glean log` → `<CR>`.

- Status: **done**.
  - `node/targets.ts`: pure/async ports of `is_pr_arg`, `github_pr_repo`, `github_remote_repo`, `resolve_dirty`/`open_dirty`, `resolve_pr`/`open_pr`, `resolve_branch`/`open_branch`, `range_identifier`/`abbrev_ref`/`review_title`, LogView (`renderLog`, `logSelection`) and PrView (`renderPrs`, paging, `parsePrList`); `spawnGhRunner` is the injectable `gh` runner with a timeout.
  - `node/glean.ts`: `parseCommand` covers bare, `<base>`, `<base> <target>`, PR number/URL, `pr`, `branch`, `log`, `prs` (`open [base]` kept as an alias of `:Glean [base]`); `openReview` keeps one review at a time (same `(repo, base, target)` reuses buffer and id and retitles; otherwise the old review is stopped and wiped); repo root resolved like `resolve_repo_root`; log/PR list state lives in node, driven by `gleanList` notifies; `TargetError`s become ERROR notifications (the `open_pr_notified` behaviour).
  - `lua/glean/node.lua`: completion list, `show_buffer` (port of `show_buffer_in_window`), listed `nofile` buffers named exactly like the old ones (review buffer name is now the plain title, no `glean://review/` prefix), log/PR keymaps (`<CR>` n/x, `]p`, `[p`, `q`), `BufReadCmd` reload, wipe → close review.
  - `default_base` default restored to `"main"`; node reads `require("glean").config.default_base` directly.
  - Tests: `node/targets.test.ts` ports the init_test cases for is_pr_arg, resolve_pr (+ repo mismatch), title identifiers (branch/PR/single ref/checkout branch), resolve_dirty, resolve_branch (local and remote), buffer titles, log view rows/selections (dirty, dirty range, single, range, from root) and PR view paging/rendering. `node/glean.test.ts` adds parseCommand cases plus driver tests for `:Glean <base> <target>` and `:Glean log` → `<CR>` / visual `<CR>` (one session listed).
  - Not ported here: `open_pr_notified` is covered by the `reported` wrapper (not separately unit-tested); api_test title/one-at-a-time cases through `glean.api` belong to stage 6 (the api `target` string is still `"worktree"`, old was `"WORKTREE"`).
  - Review follow-ups: `OpenSpec.base` is a `SpecBase` union (`rev` | `root`), replacing `fromRoot` (log selections from the root now return `open` with a root base); `reviewTitle` takes the resolved base string. `resolvePr` verifies the gh oids with `git rev-parse <oid>^{commit}` after the fetch rather than casting. `okOr` is typed against `Outcome<T>`. The review buffer's `gone` notify is an `Action` variant parsed by `parseAction`. `vim.g.glean_log_page_size` (test-only override of `LOG_PAGE_SIZE`) lets a driver test cover log paging, the stop at the end and a wiped list buffer being recreated; `parseListEvent` has unit tests. Not done: branded `Rev`/`BranchName` (nit), a driver test for PR list paging (needs `gh`; the pure `clampPage`/`renderPrs` tests cover it), and `spawnGhRunner` timeout tests (low priority).

## Navigation and jump
- Goal: `]c`/`[c`/`]f`/`[f`, `ac`, `<CR>` jump, `:Glean jump`, `D` diffsplit, `q`.
- Tests: port the navigation, jump and diffsplit cases from `init_test` and `reload_test`. A driver test jumps from a review row into the file and from the file back into the review.
- Status: **done**.
  - `node/render/nav.ts` (pure): `navRow` (`nav_to` over hunk/file headers; collapsed rows are absent from the frame), `hunkRange` (`hunk_range`), `jumpTarget`/`diffContext` (refs as a `SourceRef` union: work tree or rev; floating commit → work tree / `HEAD`, commit → `sha`/`sha^`, combined → target/base), `rowPostLnum`, `fileHeaderRow`, `sourceLineRow` (`goto_source_line` row choice).
  - `node/view/jump.ts`: `openJump` (live file when the ref is the work tree or HEAD, or when a committed line survives verbatim in the work tree via `diff <sha> -- path` + `mapLnum`; else a read-only `glean://<root>/.git//<sha>/<path>` scratch reused by name) and `openDiffsplit` (`glean://<sha8>:<path>` scratches, `iwhiteall` held while an ignore-whitespace split is open). Window work is done by `glean.node` helpers `open_file_at`, `open_scratch_at`, `diffsplit` called from node.
  - `node/view/view.ts`: `jump` action (summary-file → file header; summary-comment → off-diff `file` state opens the file, else reveal the comment, falling back to the file header — folds in the old `reveal-comment` action, which is removed), `diffsplit` action, `gotoSource` (expands file/seen/dir collapses and every marker of the path, like `goto_source_line`), and `query` for synchronous lookups.
  - `]c`/`[c`/`]f`/`[f` (n, x) and `ac` (x, o) use a `gleanQuery` rpcrequest so the cursor/selection is set before the mapping returns (needed for operator-pending `dac`); Lua applies the old `move_to_hunk_row` scroll. `q` closes the current window if it shows the review.
  - `:Glean jump` (`jumpToReview` in `glean.ts`): relative path via realpath, shows the current review or opens the default dirty review, then `gotoSource`; warns `glean: <path> is not part of the review`.
  - Tests: `node/render/nav.test.ts` ports the jump_target (combined add, deletion → base, commit scope, floating add → work tree), diff_context and `goto_source_line` row cases, plus nav/hunk range. Driver test in `node/glean.test.ts`: `]c`/`[c`, `vac`, `<CR>` into the live file at the right line, `:Glean jump` back, `D` layout.
  - Parity note: as in Lua, a deletion ties with the post-image line it precedes in `goto_source_line` and the earlier (deleted) row wins.
  - Not ported here: the deferred-jump-after-load cases (`_jump_after_refresh`) are covered by `openReview` awaiting the first refresh; the reveal of a whitespace-hidden comment (flip whitespace mode first) and `reload_test`'s ignore-whitespace jump/diffsplit cases belong with the `W` toggle in stage 3; the "reuses the scratch buffer" and live-line-follow cases are exercised by code paths but only covered by the driver test for the live case.
  - Review follow-ups: scratch buffers (jump, diffsplit) are created empty by Lua `scratch_buf` (filetype matched from the filename only) and node streams their lines in `MAX_BATCH_LINES` batches; `open_scratch_at`/`diffsplit` take buffer numbers. `<CR>`/`D`/`:Glean jump` bump a view `jumpGuard` and a superseded result never opens a window or moves the cursor (stale diffsplit scratches are wiped). `ReviewView.query` is documented as await-free. `nav.ts` narrows line rows with a guard, brands `JumpTarget`/`sourceLineRow` lnums (`PostLnum`/`PreLnum`), and `DiffContext.lnums` is a union keyed on the diff line kind. `repoRelative` is exported, validated through `toRepoPath` (`core/types.ts`) and unit-tested (`node/glean.repoRelative.test.ts`). A new driver test covers `:Glean jump` with no open review and from a file outside it (warning), `<CR>` on a summary comment of a seen/collapsed file, and `:Glean jump` into a collapsed file. Not done: refresh doesn't bump `jumpGuard` (only user jump actions do).

## Seen extras and whitespace
- Goal: `M` (unmark hunk), `U` (unmark all), `W` toggling whitespace in place (with the per-mode history cache), the `:e` hard reset, `hunk_indent` and the sticky float.
- Tests: port the matching cases, including whitespace round trips that keep the cursor and seen state. A driver test checks that the sticky float follows the cursor and closes when the buffer is hidden.
- Status: **done**.
  - `M`/`U`: pure `planUnmarkHunk` (any hunk row: header, line, marker, marker-line, comment) and `planUnmarkAll` (every commit / combined file) in `node/render/actions.ts`, sharing `stickyOf` with `planToggleSeen`; performed as undoable `seen` actions with no cursor move, as in Lua.
  - `W`: `Session.setIgnoreWhitespace` swaps the build mode, clears undo/redo and refreshes; the existing `CommitPatchCache` is keyed per mode and head, so switching back re-walks no history. The view reads the mode from the session (header, diffsplit, comment summary) and restores the cursor through `cursorAnchor`/`restoreAnchor`.
  - `:e`: review `BufReadCmd` sends a `reset` action; `resetCurrent` (`node/glean.ts`) stops the session, closes the float, blanks the buffer and its namespaces, and rebuilds session + view from the saved `SessionOpts`/`ViewOpts` in the same buffer with the same id. Parity note: nvim has already blanked the buffer and put the cursor on row 1 when `BufReadCmd` fires, so (as in Lua) the "restored" row is always 1.
  - Active hunk + `hunk_indent`: `paintHunk` in `view.ts` puts a `▌` (or the row's `+`/`-` in `GleanAddText`/`GleanDelText`) sign on every row of the cursor's hunk and, after `hunk_indent_delay_ms`, inline virtual-text indent on its non-header rows (generation-guarded). Lua sets `signcolumn=yes:1` and `scrolloff=4` on `BufWinEnter`. Config defaults `hunk_indent = 2`, `hunk_indent_delay_ms = 50` restored; node reads them from `require("glean").config`.
  - Sticky float: pure `computeAncestry`/`computePinned` (`node/render/sticky.ts`); node owns the float buffer/window (reused, repositioned via `nvim_win_set_config`). Lua sends a `cursor` action on `CursorMoved`/`WinScrolled` (buffer) and `BufWinEnter`/`BufEnter`/`WinEnter`/`WinResized`/`VimResized` (global), `sticky-close` on `WinLeave`/`BufLeave`; node re-reads the window via `glean.node.cursor_info` and closes the float when no window shows the review. Decor painting is serialized and re-run after each draw.
  - Tests: `node/render/sticky.test.ts` (compute_ancestry/compute_pinned cases), `actions.test.ts` (`M` from a partially-marked hunk, `U` in both scopes with stickies), `session/reload.test.ts` (W: per-mode history cache, undo cleared, one synthetic WORKTREE commit). Driver tests in `node/glean.test.ts`: float follows the topline, shows summary/file/hunk, closes at the top and when another buffer replaces the review, indent extmarks appear; `W` round trip keeping the cursor line, `m`/`U`, `:e` rebuilding in the same buffer.
  - Not ported here: the whitespace-comment cases (hidden/suppressed comments, comment navigation flipping the mode back) belong with the comment editor (stage 4); the "conflicting reopen applies requested mode" case has no node equivalent (the mode comes only from config, not per-open opts).
  - Review follow-ups: `paintHunk`/`paintIndent` send extmarks in `MAX_BATCH_CALLS` chunks, re-checking `indentGuard` and the frame between chunks; row→sign, row→line-hl and the sticky ancestry are computed once per frame (`frameDecor`, cached in a `WeakMap`). `detach()` clears the cursor/indent namespaces. `Ancestry` is nested (`{ commit?; file?: { row; sec?; hunk? } }`) with branded `BufRow`s; float/namespace handles are branded `WinId`/`BufNr`/`NsId` (`core/types.ts`) produced by checked wrappers. Driver tests: a superseded indent (two hunks within the delay) leaves only the latest hunk indented; a float closed externally is reopened.

## Comment editor
- Goal: `c`/visual `c`/`i`/`e`/`dd`/`dc`/visual `d` in the review buffer, with undo, as in the old code.
- Tests: port the comment editor cases from `init_test`.
- Status: **done**.
  - `node/render/commentActions.ts` (pure): `commentTarget` (port of `comment_target`/`visual_comment_target`: contiguous canonical-ordinal run in one file, `lnum` = first non-del post line, del entries carry `oldLnum`), `commentOrigin`, `commentUnder` (inline and summary comment rows), `commentsAtLine` (`dc`, via the render's comment placement), `summaryCommentsIn` (visual `d`, each record once).
  - `node/view/view.ts`: actions `add-comment` (n and x `c`; "glean: cannot comment here"), `edit-comment` (`i`/`e`, no-op when the text is unchanged), `delete-comment` (`dd`), `delete-comment-at` (`dc`; "glean: no comment on this line", `vim.ui.select` when several), `delete-comments` (visual `d`, now one undo step via a new `comments` `Undoable`), and `editor-submit`/`pick` results keyed by a token.
  - `lua/glean/node.lua`: `comment_editor` (port of `comments.open_editor`: `aboveleft split`, `:w`/`<CR>` submit, `q`/`<C-c>` cancel, insert for a new comment) and `pick_comment`; the keymaps.
  - Render parity fix: inline comments render as in Lua (`💬 [id] text`, one row per text line, `💬 (outdated) ` lead, `   ↳ reply`, `GleanCommentId` span); node previously joined lines into one row without the id.
  - Deviation: node has no per-commit exact-whitespace files, so commit scope checks a line's ordinal against the displayed commit file (real git coordinates) rather than a lineage copy.
  - Tests: `node/render/commentActions.test.ts` (single-line target + origin, visual span excluding decoration, del-only target, summary dedupe). Driver test in `node/glean.test.ts` ports the init_test cases for authoring through the editor (single/multi-line rows sharing identity), comment undo/redo, `i` edit, `dd` + undo, visual multi-line comment rendered once inline, `dc` with a picker, visual `d` as one undo step. Store-level cases (stacked comments on reopen, reply/id survival, re-anchoring, summary) were already covered by `session.test.ts`/`render/comments.test.ts`; whitespace-hidden comment cases remain for the audit stage.
  - Review follow-ups: `commentTarget` builds each file's canonical ordinals once per selection (a `Map` keyed by kind/lnums/text) instead of scanning per row. `CommentOrigin.sha` is a `Layer` (`Sha | WORKTREE`), which removes the fake-sha cast; the persisted form (`"WORKTREE"`) is unchanged. `CommentTarget.lnum` is a `PostLnum`. Prompt callbacks live in `node/view/prompts.ts` (`Prompts`): branded `PromptToken`, one table per kind, so a result of the wrong kind or a stale token does nothing and doesn't redraw (`prompts.test.ts`). `dc` narrows the single-record case by destructuring. New unit tests cover capture stopping at a file boundary, `commentsAtLine` in a second hunk, and worktree/dirty origins. Parity note: ordinals are flat across hunks, so two hunks of the same file don't form a gap; only a different file or a line missing from the canonical file stops capture, as in Lua.

## File-buffer overlay
- Goal: the `overlay.lua` behaviour in node: comments shown in file buffers, `:Glean comment` with range, and `:Glean comments` in quickfix.
- Tests: port `overlay_test.lua` in full, plus a driver test for `:Glean comment` on a range.
- Status: **done**.
  - `node/overlay/project.ts` (pure): `resolveOverlay` (group records by resolved file line, mutate + report moved `lnum`, skip del-only), `stamps` (💬 sign, eol `#id first-line`, `(+N more)`, `(outdated)` + `GleanCommentOutdated`, `GleanCommentLine` over a multi-line run, `virt_lines` when inline), `floatLines`, `recordsAt`, `jumpLnum`, `quickfixItems` (del-only / unreadable → stored lnum, `(outdated)`).
  - `node/overlay/overlay.ts`: `Overlay` handles `gleanOverlay` notifies serially (refresh, toggle, show, jump, add, edit, delete, reply, quickfix, editor-submit/pick, wipe). The store is re-read per event via the same `repoContext` the api uses; a moved record is persisted only when it moved, then live reviews of the repo `refresh()` (shared `afterRepoWrite` in `glean.ts`, now also the api's `afterRepoWrite` host hook, which additionally re-stamps file buffers). A live session's change re-stamps every loaded file buffer. Authoring captures post-image `add` entries with origin `HEAD` (dirty on a modified buffer or `git status` output; `WORKTREE`/dirty without HEAD); outside a repo it notifies "glean: not inside a git repository".
  - Undo: the gutter's per-buffer stack is shared (`FileUndo` = mark | comment, `FileGutter.push`), so `u`/`<C-r>` spend marks and comments in one order, with the existing `seq_last` wipe rule. `node_gutter.activate_undo(buf, who)` owns the `u`/`<C-r>` maps for either user (gutter, overlay); they are removed only when both release.
  - Lua: `lua/glean/node_overlay.lua` (autocmds `BufReadPost`/`FileChangedShellPost`/`BufWritePost`, the `<Plug>(glean-comment*)` maps, `overlay_keymaps` prefix, the float helper); `:Glean comment` (with range) and `:Glean comments` (quickfix + `copen`) are handled in `node.lua`; `comment_editor`/`pick_comment` take a target (review buffer or `"overlay"`). Config key `overlay = {}` restored.
  - Tests: `node/overlay/project.test.ts` (open/eol text, external move, mixed + del-only, outdated fallback, empty, float/inline, stacked, quickfix, jump). `node/overlay/overlay.driver.test.ts` ports the overlay_test flow: sign on open, `checktime` external rewrite persisted, user edit+write, float, toggle, next jump, outdated, untouched quiet file (no `u` map), `:Glean comment` single line (origin HEAD, clean) and `:3,4Glean comment` range, picker delete, `u`/`<C-r>` without touching text, `:Glean comments` quickfix, outside-repo notify.
  - Not ported as separate driver cases: "novel edit wipes the stack", "text-then-comment redo order" and "author-undo keyed to the file buffer" — the seq rule and ordering are the shared `BufUndo`'s (`bufUndo.test.ts`, gutter driver test), and `seq` is read from the file buffer via `nvim_buf_call` after the editor closes. "stable resolve does not write" is covered by `resolveOverlay(...).moved === false`.
  - Review follow-ups: the add op carries a `NewComment` (no `CommentRecord` cast; reversal drops by the id `apply()` stamped). The authoring origin is a `FileOrigin` union (`{ sha: Sha; dirty }` | `{ sha: WORKTREE; dirty: true }`) with the sha validated by a new `toSha` (`core/types.ts`). `facts()` validates the RPC tuple element types and returns `undefined`; selected lines are filtered to strings. `:Glean comments` yields (`setImmediate`) between files. The driver test now covers edit → `u`, an unchanged edit, reply → reply → `u` → `u` (back to no reply), add → `u` → `<C-r>` (same id) → `u`, and an agent `add_comment` re-stamping the open file buffer. Not done: `resolveOverlay` stays uncapped (it is bounded by one loaded buffer and its records, like the Lua version); overlay `lnum`/`line1`/`line2` remain plain numbers (nit), since they are only hints stored in `CommentRecord.lnum`.

## Agent api parity
- Goal: `session(id)`, the title and oid cases, and one-review-at-a-time behaviour.
- Tests: port the remaining `api_test.lua` cases, checking JSON shapes against the old outputs.
- Status: **done**.
  - `session(id)` added (`node/api/api.ts`, `lua/glean/api.lua`). The old Lua returned the Session object; nothing but JSON crosses the boundary now, so it returns that review's `sessions()` entry, with the same errors (none open / ambiguous / unknown id listing open reviews). Ids resolve by `g<N>` or the review buffer number (`LiveReview.bufnr`), as in Lua; the previous node-only `N` → `gN` shorthand is dropped.
  - The `target` field of a dirty review is `"WORKTREE"` again (old shape).
  - Titles (abbreviated oids, symbolic ref with `∕`, reopen keeps buffer/id) are covered by `targets.test.ts` "review titles" + `openReview` from stage 1; one-review-at-a-time is enforced by `openReview` (stage 1). `api.test.ts` adds the "single" cases: `session` by id and buffer, stale id errors naming the live one, no-arg resolves the only review. Skill doc updated.
  - Review follow-ups: `LiveReview.target` is the `Target` union (`worktree` | `ref`), so a ref named `WORKTREE` can't be confused with the work tree; only `sessions()`/`describe` render it as a string. Session addresses are a `SessionKey` union (`{kind:"id"}` | `{kind:"bufnr"}`) parsed once at dispatch; `session(key)`/`review(key)` match on the kind. Tests pin `session(id).target === WORKTREE` for a dirty review and that a bare g-number (not a buffer number) fails with the 'no review' error.

## Parity audit and docs
- Goal:
  - Go through every test in each old `*_test.lua` at `0f31363` and record in this plan where it is ported, or why it can't apply.
  - Diff the old `M.setup` command and keymap surface against the new one.
  - Restore `README.md` and `doc/glean.txt` from `0f31363`, updating only the architecture and install sections.
  - Update `context.md`.
- Tests: the full suite is green (`npx tsc -p .`, `npx vitest run`, `npx biome check .`), and every keymap and subcommand in the old README exists.
- Status: **done**.
  - Fix found by the audit: `<CR>` on a `(hidden)` summary comment (hidden by ignore-whitespace) now switches back to exact mode before revealing it, as Lua's `reveal_summary_comment` did (`view.ts` jump). Driver test "whitespace-hidden comments" in `node/glean.test.ts`.
  - Surface diff against `M.setup`/`map(...)` at `0f31363`: every `:Glean` subcommand (bare, `<base>`, `<base> <target>`, PR number/URL, `pr`, `branch`, `log`, `prs`, `jump`, `comment` with range, `comments`, `toggle-mark` with range, `toggle-gutter`) and the completion list match. Review keymaps `= m M U x:m c x:c i e x:d dd dc u <C-r> x/o:ac n/x:]c [c ]f [f <CR> D S W q`, LogView `<CR>` (n, x) `q ]p` (+`[p`, harmless extra) and PrView `<CR> ]p [p q` all exist. Config keys and defaults match; deviation: `setup` merges with `tbl_deep_extend` (old: shallow `tbl_extend`), so a partial `gutter` table keeps the other gutter defaults.
  - Docs: `README.md` and `doc/glean.txt` restored from `0f31363`; only an architecture paragraph and the install section (node 22+, `npm run build`, `GLEAN_DEV`) changed. `context.md` layout lists the new modules.
  - Test audit (old assertion groups → where they live now):
    - `api_test`: all groups → `node/api/api.test.ts`, `api.driver.test.ts` (excerpt, errors); title/single → `targets.test.ts` + stage 6 `api.test.ts` "single".
    - `async_test`: join/poll_async/superseded/closed buffer → `git/git.test.ts` (timeouts, Poller), `git/scheduler.test.ts`, `session.test.ts` "drops a refresh superseded"; open/reload/mode toggle → `reload.test.ts`; closed buffer → `glean.test.ts` log wipe + view driver. n/a: `join` of Lua coroutines as such (node uses promises).
    - `baseline_test` → `core/baseline.test.ts`; `comments_test` → `core/comments.test.ts`; `diff_test` → `core/diff.test.ts`; `dirtree_test` → `core/dirtree.test.ts`; `ignore_test` → `core/ignore.test.ts`; `intraline_test` → `core/intraline.test.ts`; `lineage_test` → `core/lineage.test.ts`; `marker_test` → `render/markers.test.ts`; `state_test` → `core/state.test.ts` (incl. Lua-written fixture shards); `git_test` → `git/git.test.ts`.
    - `dirty_combined_test` → `session/dirtyCombined.test.ts`; `wt_dup_lines_test` → `session/wtDupLines.test.ts`; `scope_cursor_test` → `render/anchor.test.ts` + view driver scope tests; `toggle_mark_test`/`file_status_test` → `gutter/marking.test.ts`, `gutter.driver.test.ts`; `gutter_test` → `gutter/project.test.ts`, `bufUndo.test.ts`, `gutter.driver.test.ts`.
    - `overlay_test` → `overlay/project.test.ts`, `overlay.driver.test.ts` (per stage 5 notes).
    - `reload_test` → `session/reload.test.ts` (open/edit/idle/commit/untracked/ignore live), `glean.test.ts` (`:e` reset, W, diffsplit layout); ignore diffsplit covered by `openDiffsplit`'s `iwhiteall` path (stage 2 note).
    - `suspend_test` → `view.driver.test.ts` "suspends painting while hidden"; idempotency is structural (`suspend`/`resume` guard on state).
    - `init_test`: render/progress/row_map/collapse/commits/toggle/unseen/seen-section/marker/demote/stage2–5/combined → `render/render.test.ts`, `markers.test.ts`, `actions.test.ts`, `model.test.ts`, `session.test.ts`, view driver; comment/reply/delete/author/multiline/visual/origin/reanchor/dd/summary*/ctx-summary/undo → `render/comments.test.ts`, `commentActions.test.ts`, `session.test.ts`, `glean.test.ts` comment editor; hunk indent/sticky/anc/pin → `sticky.test.ts` + driver; jump*/diffsplit/wt jump/multihunk/two-hunk → `nav.test.ts` + driver; log/prs/resolver/pr arg/resolve_pr/resolve_branch/title/buffer/dirty resolver → `targets.test.ts` + driver; whitespace model/cache/runtime/state/comments → `reload.test.ts`, `comments.test.ts`, W driver, new hidden-comment driver; repo_state_dir/wt_shard → `glean.test.ts` `storePaths`; worktree*/wt*/wt del/del dup/xscope del/identity/inv/baseline/no-worktree/gleanignore → `model.test.ts`, `session.test.ts`, `dirtyCombined.test.ts`, `api.test.ts`; off-diff/sync → `session.test.ts` commentSummary, overlay driver (api add re-stamps file buffer); intra → `view.driver.test.ts` intra-line; command → `glean.test.ts` parseCommand.
    - Not applicable: `init_test` `incremental-reload` (asserts Lua's per-file lazy blame `owner_status`; node computes ownership by lineage over cached per-commit patches, covered by `reload.test.ts` "reuses commit patches"), `dsm` (Lua `_internal.display_seen_map`; its behaviour is `displaySeenSet` in `markers.test.ts`), `testutil_test` (the Lua fixture helper was deleted; `node/test/repo.ts` is exercised by every git test, merges by `git.test.ts` "merge history").
