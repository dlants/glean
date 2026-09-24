---
name: testing
description: How to write and run tests in glean. Two tiers - fast node-only tests against real git repos in tmp dirs, and nvim driver tests for bindings/display. Use when adding, modifying or debugging tests.
---

# Testing in glean

Run all tests with `npx vitest run`, a single file with `npx vitest run <file>`, a single test with `-t "<name>"`. No need to cd. Vitest config is `vitest.config.ts` (forks pool, max 4 forks, 30s timeout).

There are two tiers. **Default to tier 1.** Only reach for tier 2 when the behavior genuinely requires a running nvim.

## Tier 1: node-only tests (`*.test.ts`)

For models, git operations, state/store, seen classification, baseline algebra, rendering to a `Frame`, action planning, nav targets, api responses — anything that can be observed as a return value or a data structure. These are fast: no nvim, just node + git.

- Colocate next to the module: `node/session/session.test.ts` tests `node/session/session.ts`.
- Use genuine git repos, never mocked git output. `makeRepo(spec)` from `node/test/repo.ts` creates a hermetic repo in a tmp dir: each `CommitSpec` is one commit (`files`, `delete`, `rename`, `empty`, `branch`, `merge`, `msg`). Global/system git config is nulled and author/dates are fixed, so shas are deterministic. It returns `{ root, run, shas, env }`; use `repo.run([...])` for extra git commands and `writeFileSync(join(repo.root, p), ...)` for uncommitted worktree edits.
- Build the real backend objects on top of it: `new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) })`, then `Session`, `buildModel`, `render`, etc.
- Use a fresh `mkdtempSync(join(tmpdir(), "glean-..."))` for the store (`stateDir`) so tests are isolated and can run in parallel.
- Pure modules in `node/core/` (diff, linediff, ranges, baseline, …) need no repo at all — just call them.
- To test a display concern without nvim, assert on the `Frame` returned by `render` (row text and `RowTarget`s) rather than on buffer contents.

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Git, spawnRunner } from "../git/git.ts";
import { makeRepo } from "../test/repo.ts";
import { Session } from "./session.ts";

it("counts one unseen add", async () => {
  const repo = makeRepo([
    { files: { "a.txt": "1\n2\n" } },
    { files: { "a.txt": "1\nX\n" } },
  ]);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const s = new Session({
    git,
    base: repo.shas[0] ?? "",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-store-")),
  });
  await s.refresh();
  expect(s.current?.cls.progressCounts("combined").adds).toBe(1);
});
```

## Tier 2: nvim tests (`*.driver.test.ts`)

For keymaps and bindings, `:Glean` commands, what actually lands in the scratch buffer (lines, extmarks, highlights, folds), cursor movement, windows/splits, the sticky float, file-buffer gutter and comment overlay, the Lua agent api shim, and the Lua↔node bridge. Each test spawns its own headless nvim, so these are slow — keep them few and focused on the nvim-facing seam; push logic assertions down to tier 1.

Helpers in `node/test/driver.ts`:
- `withNvim(fn)` — spawns `nvim --headless --clean` with glean on the rtp and `GLEAN_DEV=1` (runs TS source, no build needed), attaches an RPC client, and tears everything down afterwards.
- `startBackend(nvim)` — starts the glean node backend and waits for the channel to bridge back.
- `luaEval(nvim, expr)` — evaluate a Lua expression and return its value.
- `pollUntil(check, timeoutMs?)` — retry until `check` returns non-`undefined`. Rendering is async; always wait with this, never with `sleep`.

Pattern: make a repo, `cd` nvim into it and point `vim.g.glean_state_dir` at a tmp dir, start the backend, drive nvim with real input (`nvim_command`, `nvim_input`, `nvim_win_set_cursor`), and poll the buffer for the expected state.

```typescript
const repo = makeRepo([
  { files: { "a.txt": "1\n2\n3\n" } },
  { msg: "one", files: { "a.txt": "1\nX\n3\n" } },
]);
const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
await withNvim(async (nvim) => {
  await luaEval(
    nvim,
    `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
  );
  await startBackend(nvim);
  await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
  const lines = () =>
    luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
  const first = await pollUntil(async () => {
    const l = await lines();
    return l.some((s) => s.includes("a.txt")) ? l : undefined;
  });
  expect(first[0]).toContain("unreviewed: 1 file");
});
```

If a helper is reused across driver tests (open a review in a repo, read buffer lines, press a key on a row), add it to `node/test/driver.ts` rather than copying it between files.

## Choosing a tier

- Is the thing under test a value computed in node (model, seen set, counts, frame rows, action plan, nav target, api payload)? → tier 1.
- Does it only exist once nvim applies it (keymap wiring, buffer text after row-diffed writes, extmarks/highlights, window layout, float, autocmds on file buffers)? → tier 2.
- A feature spanning both usually gets many tier-1 tests for the logic plus one tier-2 smoke test that the binding reaches it.

## Practices

- Always `await`; never use fixed sleeps to wait on renders or polls.
- Every test builds its own repo and state dir — no shared fixtures, no cleanup needed for correctness.
- Test through real git and real edits rather than constructing internal state by hand.
- Before finishing, run `npx tsc -p .`, `npx biome check .` and the affected tests.
