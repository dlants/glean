# Objective and Context

User request: "Glean ended up crashing a couple of my neovim sessions [...] Both are stuck in the glean plugin's intra-line diff highlighting, running synchronously on the main Lua thread. [...] I want to make this impossible to happen again. Glean should never run anything in the main thread so that even if it gets stuck or is doing something computationally expensive, we should run that in an isolated way (so that Glean is safe to run in any session)." Then: "I'm actually feeling that it's about time we switched to a different language that has better semantics for this so I want to use TypeScript. See how ~/src/magenta.nvim/ is set up with the lua part vs the node process. Set it up exactly the same way. You can copy/paste all the nvim communication stuff. Then convert the code into typescript. Do your best to leverage the type system - make the types non-representative. Actually, add some review guidance for this in the same way magenta does. Write up a plan"

## Diagnosis being fixed

- `intraline.pair_lines` scores every del×add pair with a full token DP (`M.align`), so one block costs about m·n·|ta|·|tb| time plus allocation. That is what caused the 3 GB spin.
- `INTRA_BUDGET` in `init.lua` counts `#dels + #adds` and is only checked between blocks. A single `refine` call can't be interrupted.
- Git runs through `vim.system(...):wait()`, which blocks the UI whenever git is slow.
- The root cause is that all compute and IO share the nvim main loop. Moving to a node process removes this by construction: nvim only ever handles RPC notifications and buffer or extmark writes.

## Reference: magenta's split (to copy)

- `lua/magenta/init.lua`:
  - `M.start` runs `jobstart({"node", dist/magenta.mjs})`, or in dev mode (`MAGENTA_DEV=1`) runs source via `--experimental-transform-types --import boot.mjs index.ts`.
  - `M.bridge(channelId)` is called back by node. It registers the user command and autocmds in a named augroup, and forwards them through `safe_rpcnotify`.
  - `M.teardown_bridge` runs on job exit or a dead channel. A `VimLeavePre` autocmd calls `jobstop`.
- `node/nvimclient/index.ts`: reads `process.env.NVIM` and calls `attach({socket})` from `nvim/nvim-node`. Handles SIGTERM.
- `node/nvimclient/nvim/nvim-node/`: `attach.ts`, `types.ts`, `neovim-api.types.ts`, `logger.ts` and the `cli/generate.ts` typed-API generator. These are copied verbatim.
- `node/nvimclient/nvim/{nvim.ts,buffer.ts,window.ts,extmarks.ts}`: typed buffer, window and extmark helpers. Copied, then trimmed to what glean uses.
- `node/nvimclient/test/driver.ts` and `setup.ts`: vitest with a real embedded nvim. The pattern is copied.
- `scripts/build.mjs` (esbuild bundle to `dist/*.mjs`), `tsconfig.json` (strict, `exactOptionalPropertyTypes`, `.ts` imports, `noEmit`), `biome.json`, `vitest.config.ts`, and the `pre-commit` hook.
- `.github/instructions/*.instructions.md`: review guidance consumed by the `code-review` script.

## Glean today (~10k src lines, ~10k test lines, Lua)

- `init.lua` (5.5k): setup, `:Glean`, model build, renderer, `row_map`, actions and keymaps, polling, and both scopes.
- Pure modules: `diff`, `intraline`, `baseline`, `provenance`, `ignore`, `lineage`, `overlay`, `comments`, `dirtree`.
- IO modules: `git` (injectable runner), `state` (sharded JSON store), `gutter`, `bufundo`, `api` (agent JSON surface over `nvim_exec_lua`).

# Design

Glean gets a single node process per nvim, laid out like magenta but as one flat package (no workspaces, no core/nvim split).

- The **Lua side is thin**: start and bridge, the `:Glean` command, keymaps that `rpcnotify` an action name plus cursor row, autocmds (BufEnter/TextChanged/BufWritePost/CursorMoved on file buffers), and the `api.lua` shim. Lua never computes anything. Every handler is O(1) plus one rpcnotify.
- The **node main thread** owns the model, review store, `row_map`, collapse state and scheduling. It renders by sending batched `nvim_buf_set_lines` and extmark calls (via `nvim_call_atomic`, or one `nvim_exec_lua` chunk per batch) to a nomodifiable scratch buffer. Its event loop must stay responsive so that RPC requests (the api surface) return quickly.
- **Heavy pure work** (`intraline.refine`, blame parsing, baseline classification) runs on the node event loop. Node being a separate process is the isolation: a slow computation delays glean's own responses, never nvim. To keep node responsive to RPC, long batches are chunked with `setImmediate` yields between blocks, and a generation counter drops stale results.
- **Git** is async only: `child_process.spawn` wrapped in an injectable `GitRunner`, with per-call timeouts and a poll that won't overlap itself.
- **Algorithmic caps stay** in intraline (m·n cell cap, token-product cap, and a length-ratio pre-filter) so no single block monopolizes the event loop.

The agent API (magenta's `nvim_exec_lua` calls into `require("glean.api")`) keeps its Lua entrypoints. Each one becomes `vim.rpcrequest(channel, "glean.api", name, args)`. Because rpcrequest blocks nvim until node replies, node serves these from in-memory state only. Anything that needs git or fresh computation returns `{status: "pending"}` or awaits with a short timeout. The skill doc is updated to match.

## Interfaces

Core types, written to follow the new review guidance:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type Sha = Brand<string, "Sha">;
type RepoPath = Brand<string, "RepoPath">;
type HeadLnum = Brand<number, "HeadLnum">;      // line in the tip commit H
type WorktreeLnum = Brand<number, "WorktreeLnum">;
type PostLnum = Brand<number, "PostLnum">;      // post-image of a commit
type PreLnum = Brand<number, "PreLnum">;

type LineId =
  | { kind: "committed-add"; sha: Sha; lnum: PostLnum }
  | { kind: "committed-del"; removerSha: Sha; lnum: PreLnum }
  | { kind: "worktree-add"; path: RepoPath; lnum: WorktreeLnum }
  | { kind: "worktree-del"; path: RepoPath; lnum: HeadLnum };

type DiffLine =
  | { kind: "ctx"; text: string; oldLnum: number; newLnum: number }
  | { kind: "add"; text: string; newLnum: number }
  | { kind: "del"; text: string; oldLnum: number };

type Scope = { kind: "combined" } | { kind: "commits" };

type RowTarget =
  | { kind: "commit-header"; sha: Sha }
  | { kind: "file-header"; owner: Owner; path: RepoPath }
  | { kind: "hunk-header"; owner: Owner; path: RepoPath; hunk: number }
  | { kind: "line"; owner: Owner; path: RepoPath; hunk: number; li: number; id: LineId }
  | { kind: "seen-marker"; ids: readonly LineId[] }
  | { kind: "blank" };
type Owner = { kind: "commit"; sha: Sha } | { kind: "worktree" };

type WorktreeRecord = {
  head: ContentHash;              // anchor on H's content
  baseline: readonly string[];    // R, invariant: diff(H, R) is add-only
  dels: RangeSet<HeadLnum>;
};

type Action =                     // everything lua can send
  | { kind: "toggle-seen"; row: number; count: number }
  | { kind: "toggle-fold"; row: number }
  | { kind: "toggle-scope" }
  | { kind: "comment"; row: number; text: string }
  /* ...one variant per current keymap action */;

interface GitRunner { run(args: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<GitResult> }
type GitResult = { kind: "ok"; stdout: string } | { kind: "error"; code: number; stderr: string } | { kind: "timeout" };
```

On disk, the store keeps its current JSON shape, so existing `<dir>/<sha>.json` shards load unchanged. It's parsed at the boundary by hand-written validators into the branded types.

Lua ↔ node:

- lua → node, notification: `glean.action(sessionId, Action)`, `glean.event(kind, bufnr)`, `glean.command(args)`.
- lua → node, request: `glean.api(name, args)`, which returns JSON.
- node → lua: plain nvim API calls. There are no custom Lua callbacks except `require("glean").bridge(channelId)`.

## Invariants

- No Lua code path does more than constant work plus an rpcnotify. Rendering batches are bounded in size.
- The node main thread never runs an unbounded pure computation. Superlinear work is capped per block and yields between blocks.
- Every git call has a timeout. Polls never overlap.
- Stale results (generation mismatch) are dropped, never applied.
- If node crashes, the nvim session keeps working (bridge teardown as in magenta). The review buffer shows "glean: backend exited" instead of erroring.
- Existing persisted stores stay readable. All seen-model semantics in `context.md` are preserved exactly (identity kinds, baseline algebra, `min_seen_run` demotion, sticky overrides, `.gleanignore` derived-seen, scope-toggle cursor preservation).
- Line identities are equal across scopes. The ported lineage and provenance tests must still pass.

# Stages

## Scaffold and review guidance

- Goal: `:Glean` starts a node process that bridges back and echoes the command. Tooling works.
- Work:
  - Copy `nvim-node/`, `nvim.ts`, `buffer.ts`, `window.ts`, `extmarks.ts`, `boot.mjs`, `index.ts` (trimmed), `scripts/build.mjs`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, the test driver and `pre-commit`.
  - Write the Lua `start`/`bridge`/`teardown_bridge`/`safe_rpcnotify` from magenta's `init.lua`.
  - Add `.github/instructions/`:
    - `type-representation.instructions.md`, copied and extended with glean examples: `LineId` union instead of `{sha?, path?, lnum}`, branded lnums so a head line can't be passed where a work-tree line is expected, `RowTarget` instead of nullable fields.
    - `general-typescript.instructions.md` and `test-coverage.instructions.md`, adapted.
    - `no-main-thread-compute.instructions.md` (new): flags any Lua work beyond dispatch, any synchronous superlinear work on the node main thread, and git calls without a timeout.
- Tests: a driver test starts nvim, runs `:Glean ping`, and asserts node received it. Killing node leaves nvim usable and removes `:Glean`.
- Status: done (05042d0), reviewed clean.
  - Layout: flat `node/` (`index.ts`, `glean.ts`, `boot.mjs`, `nvim/` with `nvim-node/` copied verbatim and `buffer.ts`/`window.ts`/`extmarks.ts`/`nvim.ts` trimmed of magenta-specific helpers), `node/test/driver.ts` (`withNvim`, `startBackend`, `pollUntil`), `scripts/build.mjs` → `dist/glean.mjs` (gitignored), `tsconfig.json`, `biome.json`, `vitest.config.ts`, `pre-commit`. Commands: `npx tsc -p .`, `npx vitest run`, `npx biome check .`, `npm run bundle`.
  - Deviation: until cutover the Lua implementation still owns `:Glean`, so the bridge lives in `lua/glean/node.lua` and registers `:GleanNode` (the ping test runs `:GleanNode ping`; the crash test asserts `:GleanNode` is removed). Node is started explicitly via `require("glean.node").start()`, not from `setup`. Rename to `:Glean` and wire into `setup` at cutover.
  - `start` sets `env.NVIM = vim.v.servername` (starting a server if needed): an inherited `$NVIM` (nvim run from a `:terminal`, or tests run under another nvim) otherwise attaches node to the wrong instance. magenta has the same latent bug.
  - Test driver is a small fresh `withNvim` (headless nvim with the repo on rtp, `GLEAN_DEV=1`) rather than magenta's full preamble; tests exercise the real Lua `start` → node → `bridge` path.
  - Review guidance: `.github/instructions/{general-typescript,test-coverage,type-representation,no-main-thread-compute}.instructions.md`.

## Pure module port

- Goal: `diff`, `intraline` (with caps), `baseline`, `provenance`, `ignore`, `lineage`, `overlay`, `comments`, `dirtree` and `state` are ported using the types above.
- Tests: port every `*_test.lua` case to vitest one-for-one; the existing tests are the spec. Add intraline tests with a synthetic 2000×2000 block of long lines that finishes in under 200 ms and still pairs obviously similar lines. `state` loads fixture shards written by the current Lua version.
- Note: `baseline` uses `vim.diff`. Replace it with the `diff` npm package (already one of magenta's dependencies) or a small Myers implementation, and check alignment parity on the existing baseline tests, including repeated-line cases.

## Async git and scheduling

- Goal: `git.ts` runs on an injectable async `GitRunner` with timeouts. The refine scheduler yields between blocks and filters by generation.
- Tests:
  - A fake runner covers the git_test cases.
  - During a large refine, an RPC request interleaves (it is answered before the refine finishes).
  - A stale-generation response is dropped.

## Model, renderer and actions

- Goal: port `init.lua` as `session.ts` (model build, refresh, polling), `render.ts` (pure `Model -> {lines, highlights, rowMap}`), `actions.ts` (a reducer over `Action`) and `nvimView.ts` (applies render output in bounded batches and diffs against the previous frame so it doesn't rewrite the whole buffer). Keymaps are defined in Lua and dispatch `Action`s.
- Tests: port `init_test`, `scope_cursor_test`, `reload_test`, `suspend_test`, `marker_test`, `dirty_combined_test` and `wt_dup_lines_test`, mostly against the pure renderer and reducer. A driver test checks the keymap → action → buffer round trip. A driver test with a huge generated hunk asserts that nvim answers `nvim_eval("1")` within 50 ms during the refresh.

## Gutter and file-buffer marking

- Goal: `gutter.ts` projects into file buffers from BufEnter/TextChanged events, fetching buffer text via `nvim_buf_get_lines`. The gitsigns detach/reattach stays in Lua as a small helper that node calls. `:Glean toggle-mark` and the `gmc` hunk highlight are ported. `bufundo` is ported too.
- Tests: port `gutter_test` and `toggle_mark_test`. A driver test edits a file buffer and sees signs update.

## Agent API

- Goal: `api.lua` becomes an rpcrequest shim, `api.ts` serves from memory, and `skills/glean-review/skill.md` is updated.
- Tests: port `api_test`. Call the api while a refresh is running and assert it returns promptly.

## Cutover

- Goal: delete the Lua implementation modules, `run_tests.lua` and `testutil.lua`. Update `README.md` and `context.md` (architecture, layout, commands: `npx tsc`, `npx vitest run`, `npx biome check .`, `npm run build`). `dist/` is built and bundled the way magenta does it.
- Tests: the full suite, and a manual review in `dlants-monolith-temporal-eks` and `dlants-ddt-simplification`, the two repos that caused the hangs.
