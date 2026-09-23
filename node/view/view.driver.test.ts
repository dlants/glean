import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { luaEval, pollUntil, startBackend, withNvim } from "../test/driver.ts";
import { makeRepo } from "../test/repo.ts";

describe("review view (driver)", () => {
  it("renders, and m round-trips through node to the buffer", async () => {
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
      const row = first.findIndex((s) => s.includes("@@")) + 1;
      await nvim.call("nvim_win_set_cursor", [0, [row, 0]]);
      await nvim.call("nvim_input", ["m"]);
      await pollUntil(async () => {
        const l = await lines();
        return l[0]?.includes("unreviewed: 1 file") ? undefined : l;
      });
    });
  });

  it("m lands the cursor on the next unseen hunk", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n", "b.txt": "1\n" } },
      { msg: "one", files: { "a.txt": "A\n", "b.txt": "B\n" } },
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
        return l.filter((s) => s.includes("@@")).length === 2 ? l : undefined;
      });
      const row = first.findIndex((s) => s.includes("@@")) + 1;
      await nvim.call("nvim_win_set_cursor", [0, [row, 0]]);
      await nvim.call("nvim_input", ["m"]);
      await pollUntil(async () => {
        const l = await lines();
        const [cur] = await luaEval<[number, number]>(
          nvim,
          "vim.api.nvim_win_get_cursor(0)",
        );
        const hunks = l.filter((s) => s.includes("@@")).length;
        return hunks === 1 && l[cur - 1]?.includes("@@") ? true : undefined;
      });
    });
  });
  it("toggle-scope re-renders in the commits scope", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n" } },
      { msg: "second commit", files: { "a.txt": "2\n" } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      const text = () =>
        luaEval<string[]>(
          nvim,
          "vim.api.nvim_buf_get_lines(0, 0, -1, false)",
        ).then((l) => l.join("\n"));
      await pollUntil(async () =>
        (await text()).includes("a.txt") ? true : undefined,
      );
      await nvim.call("nvim_input", ["S"]);
      await pollUntil(async () =>
        (await text()).includes("second commit") ? true : undefined,
      );
    });
  });
  it("paints intra-line emphasis and keeps the cursor line across scopes", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "keep\nalpha beta gamma\n" } },
      { msg: "edit", files: { "a.txt": "keep\nalpha BETA gamma\n" } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      await pollUntil(async () => {
        const n = await luaEval<number>(
          nvim,
          `#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace("glean-review-intra"), 0, -1, {})`,
        );
        return n > 0 ? true : undefined;
      });
      const lines = await luaEval<string[]>(
        nvim,
        "vim.api.nvim_buf_get_lines(0, 0, -1, false)",
      );
      const row = lines.indexOf("alpha BETA gamma") + 1;
      expect(row).toBeGreaterThan(0);
      await nvim.call("nvim_win_set_cursor", [0, [row, 0]]);
      await nvim.call("nvim_input", ["S"]);
      await pollUntil(async () => {
        const cur = await luaEval<string>(
          nvim,
          "vim.api.nvim_get_current_line()",
        );
        const all = await luaEval<string[]>(
          nvim,
          "vim.api.nvim_buf_get_lines(0, 0, -1, false)",
        );
        return all.some((l) => l.includes("edit")) && cur === "alpha BETA gamma"
          ? true
          : undefined;
      });
    });
  });
  it("toggle-scope expands a collapsed destination file", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "keep\n" } },
      { msg: "edit", files: { "a.txt": "keep\nadded line\n" } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      const getLines = () =>
        luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
      await pollUntil(async () =>
        (await getLines()).includes("added line") ? true : undefined,
      );
      const header = (await getLines()).findIndex((l) => l.includes("a.txt"));
      await nvim.call("nvim_win_set_cursor", [0, [header + 1, 0]]);
      await nvim.call("nvim_input", ["="]);
      await pollUntil(async () =>
        (await getLines()).includes("added line") ? undefined : true,
      );
      await nvim.call("nvim_input", ["S"]);
      await pollUntil(async () =>
        (await getLines()).includes("added line") ? true : undefined,
      );
      const row = (await getLines()).indexOf("added line") + 1;
      await nvim.call("nvim_win_set_cursor", [0, [row, 0]]);
      await nvim.call("nvim_input", ["S"]);
      await pollUntil(async () =>
        (await luaEval<string>(nvim, "vim.api.nvim_get_current_line()")) ===
        "added line"
          ? true
          : undefined,
      );
    });
  });

  it("summary <CR> reveals the comment and visual d deletes it", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n2\n3\n" } },
      { msg: "one", files: { "a.txt": "1\nX\n3\n" } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo.root,
      encoding: "utf8",
    }).trim();
    const store = new Store(stateDir, `WORKTREE/${branch}`);
    await store.load([]);
    store.addCommentRecord("a.txt" as RepoPath, {
      lnum: 2,
      content: [{ kind: "add", text: "X" }],
      text: "why X?",
      reply: undefined,
      origin: undefined,
    });
    await store.save(store.wtShard);
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      const lines = () =>
        luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
      const hits = (l: string[]) =>
        l.flatMap((s, i) => (s.includes("why X?") ? [i + 1] : []));
      const first = await pollUntil(async () => {
        const l = await lines();
        return hits(l).length === 2 ? l : undefined;
      });
      const [inline, summary] = hits(first) as [number, number];
      await nvim.call("nvim_win_set_cursor", [0, [summary, 0]]);
      await nvim.call("nvim_input", ["<CR>"]);
      await pollUntil(async () => {
        const [cur] = await luaEval<[number, number]>(
          nvim,
          "vim.api.nvim_win_get_cursor(0)",
        );
        return cur === inline ? true : undefined;
      });
      await nvim.call("nvim_win_set_cursor", [0, [summary, 0]]);
      await nvim.call("nvim_input", ["Vd"]);
      await pollUntil(async () =>
        hits(await lines()).length === 0 ? true : undefined,
      );
    });
  });
  it("nvim stays responsive (<50 ms) while a huge hunk renders", async () => {
    const n = 3000;
    const mk = (tag: string) =>
      Array.from(
        { length: n },
        (_, i) => `${tag} line ${i} ${"word ".repeat(30)}${i * 7}`,
      ).join("\n");
    const repo = makeRepo([
      { files: { "big.txt": `${mk("old")}\n` } },
      { msg: "rewrite", files: { "big.txt": `${mk("new")}\n` } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      let worst = 0;
      await pollUntil(async () => {
        const t = performance.now();
        await nvim.call("nvim_eval", ["1"]);
        worst = Math.max(worst, performance.now() - t);
        const c = await luaEval<number>(
          nvim,
          `#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace("glean-review-intra"), 0, -1, {})`,
        );
        return c > 0 ? true : undefined;
      }, 30_000);
      expect(worst).toBeLessThan(50);
    });
  }, 60000);
});

describe("review view visibility (driver)", () => {
  it("suspends painting while hidden and catches up when re-displayed", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n" } },
      { msg: "one", files: { "a.txt": "ONE\n" } },
    ]);
    const stateDir = mkdtempSync(join(tmpdir(), "glean-view-"));
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      const buf = await pollUntil(async () => {
        const b = await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()");
        const name = await luaEval<string>(
          nvim,
          `vim.api.nvim_buf_get_name(${b})`,
        );
        return name.startsWith("glean://review/") ? b : undefined;
      });
      const body = async () =>
        (
          await luaEval<string[]>(
            nvim,
            `vim.api.nvim_buf_get_lines(${buf}, 0, -1, false)`,
          )
        ).join("\n");
      await pollUntil(async () =>
        (await body()).includes("ONE") ? true : undefined,
      );
      // Let the first poll tick record its baseline signature.
      await new Promise((r) => setTimeout(r, 1200));
      await nvim.call("nvim_command", ["enew"]);
      writeFileSync(join(repo.root, "a.txt"), "TWO\n");
      await new Promise((r) => setTimeout(r, 1500));
      expect(await body()).not.toContain("TWO");
      await nvim.call("nvim_command", [`buffer ${buf}`]);
      await pollUntil(async () =>
        (await body()).includes("TWO") ? true : undefined,
      );
    });
  }, 20000);
});
