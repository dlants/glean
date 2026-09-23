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

## Navigation and jump
- Goal: `]c`/`[c`/`]f`/`[f`, `ac`, `<CR>` jump, `:Glean jump`, `D` diffsplit, `q`.
- Tests: port the navigation, jump and diffsplit cases from `init_test` and `reload_test`. A driver test jumps from a review row into the file and from the file back into the review.

## Seen extras and whitespace
- Goal: `M` (unmark hunk), `U` (unmark all), `W` toggling whitespace in place (with the per-mode history cache), the `:e` hard reset, `hunk_indent` and the sticky float.
- Tests: port the matching cases, including whitespace round trips that keep the cursor and seen state. A driver test checks that the sticky float follows the cursor and closes when the buffer is hidden.

## Comment editor
- Goal: `c`/visual `c`/`i`/`e`/`dd`/`dc`/visual `d` in the review buffer, with undo, as in the old code.
- Tests: port the comment editor cases from `init_test`.

## File-buffer overlay
- Goal: the `overlay.lua` behaviour in node: comments shown in file buffers, `:Glean comment` with range, and `:Glean comments` in quickfix.
- Tests: port `overlay_test.lua` in full, plus a driver test for `:Glean comment` on a range.

## Agent api parity
- Goal: `session(id)`, the title and oid cases, and one-review-at-a-time behaviour.
- Tests: port the remaining `api_test.lua` cases, checking JSON shapes against the old outputs.

## Parity audit and docs
- Goal:
  - Go through every test in each old `*_test.lua` at `0f31363` and record in this plan where it is ported, or why it can't apply.
  - Diff the old `M.setup` command and keymap surface against the new one.
  - Restore `README.md` and `doc/glean.txt` from `0f31363`, updating only the architecture and install sections.
  - Update `context.md`.
- Tests: the full suite is green (`npx tsc -p .`, `npx vitest run`, `npx biome check .`), and every keymap and subcommand in the old README exists.
