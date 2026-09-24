import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { luaEval, pollUntil, startBackend, withNvim } from "../test/driver.ts";
import { makeRepo } from "../test/repo.ts";

const setup = (root: string, stateDir: string) =>
  `(function() vim.cmd.cd(${JSON.stringify(root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`;

describe("agent api (driver)", () => {
  it("round-trips through the Lua shim", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n2\n3\n" } },
      { msg: "one", files: { "a.txt": "1\nX\n3\n" } },
    ]);
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        setup(repo.root, mkdtempSync(join(tmpdir(), "glean-api-"))),
      );
      await startBackend(nvim);
      const api = (expr: string) =>
        luaEval<unknown>(nvim, `require("glean.api").${expr}`);
      expect(await api("comments()")).toEqual([]);
      const id = await api(
        `add_comment({ path = "a.txt", lnum = 2, text = "why" })`,
      );
      await api(`reply(nil, ${id}, "because")`);
      expect(await api("comments()")).toMatchObject([
        { id, text: "why", reply: "because", state: "file" },
      ]);
      expect(
        await luaEval(nvim, `select(2, pcall(require("glean.api").hunks))`),
      ).toContain("no review is open");
      expect(
        await luaEval(
          nvim,
          `select(2, pcall(require("glean.api").comments, { repo = "/" }))`,
        ),
      ).toContain("/ is not inside a git repository");

      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      const sessions = await pollUntil(async () => {
        const s = (await api("sessions()")) as { id: string; title: string }[];
        return s.length === 1 ? s : undefined;
      });
      expect(sessions[0]?.title).toContain(`Glean:${sessions[0]?.id}`);
      const page = await pollUntil(async () => {
        const p = (await api(`hunks("${sessions[0]?.id}")`)) as {
          hunks?: { id: string }[];
          cursor?: unknown;
        };
        return p.hunks?.length === 1 ? p : undefined;
      });
      expect(page.cursor).toBeUndefined();
      const lines = () =>
        luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
      const rendered = await pollUntil(async () => {
        const l = await lines();
        return l.some((s) => s.includes("@@")) ? l : undefined;
      });
      const excerpt = (await api(
        `excerpt(nil, 1, ${rendered.length})`,
      )) as string;
      expect(excerpt.split("\n").slice(0, 2)).toEqual([
        "a.txt",
        expect.stringContaining("@@"),
      ]);
      expect(excerpt).toContain("\n+X");
      expect(await api(`mark(nil, "${page.hunks?.[0]?.id}")`)).toEqual({
        hunks: 1,
        lines: 2,
      });
    });
  });

  it("answers promptly while a huge review is refreshing", async () => {
    const n = 1000;
    const mk = (tag: string) =>
      Array.from(
        { length: n },
        (_, i) => `${tag} line ${i} ${"word ".repeat(30)}${i}`,
      ).join("\n");
    const repo = makeRepo([
      { files: { "big.txt": `${mk("old")}\n` } },
      { msg: "rewrite", files: { "big.txt": `${mk("new")}\n` } },
    ]);
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        setup(repo.root, mkdtempSync(join(tmpdir(), "glean-api-"))),
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean open ${repo.shas[0]}`]);
      let worst = 0;
      let answered = false;
      await pollUntil(async () => {
        const t = performance.now();
        const r = (await luaEval<{ status?: string; total?: number }>(
          nvim,
          `require("glean.api").hunks(nil, { limit = 1 })`,
        ).catch(() => undefined)) ?? { status: "no-session" };
        worst = Math.max(worst, performance.now() - t);
        if (r.total !== undefined) answered = true;
        return answered ? true : undefined;
      }, 30_000);
      expect(worst).toBeLessThan(500);
    });
  }, 60000);
});
