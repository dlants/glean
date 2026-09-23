import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
      await nvim.call("nvim_command", [`GleanNode open ${repo.shas[0]}`]);
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
      await nvim.call("nvim_command", [`GleanNode open ${repo.shas[0]}`]);
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
});
