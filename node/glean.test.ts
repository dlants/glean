import { describe, expect, it } from "vitest";
import { parseCommand } from "./glean.ts";
import { luaEval, pollUntil, startBackend, withNvim } from "./test/driver.ts";

describe("parseCommand", () => {
  it("recognizes ping and rejects non-string args", () => {
    expect(parseCommand(["ping"])).toEqual({ kind: "ping" });
    expect(parseCommand(["nope", "x"])).toEqual({
      kind: "unknown",
      args: ["nope", "x"],
    });
    expect(parseCommand(["open"])).toEqual({ kind: "open", base: "HEAD" });
    expect(parseCommand(["open", "main"])).toEqual({
      kind: "open",
      base: "main",
    });
    expect(parseCommand([1])).toEqual({ kind: "unknown", args: [] });
  });
});

describe("node bridge", () => {
  it(":GleanNode ping reaches node and node answers", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      await nvim.call("nvim_command", ["GleanNode ping"]);
      const pongs = await pollUntil(() =>
        luaEval<number | null>(nvim, "vim.g.glean_pong").then(
          (p) => p ?? undefined,
        ),
      );
      expect(pongs).toBe(1);
    });
  });

  it("killing node tears down the bridge and leaves nvim usable", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      const pid = await luaEval<number>(
        nvim,
        `vim.fn.jobpid(require("glean.node").job_id)`,
      );
      process.kill(pid, "SIGKILL");
      await pollUntil(async () =>
        (await luaEval<number>(nvim, `vim.fn.exists(":GleanNode")`)) === 0
          ? true
          : undefined,
      );
      expect(await luaEval<null>(nvim, "vim.g.glean_node_channel")).toBe(null);
      expect(await nvim.call("nvim_eval", ["1 + 1"])).toBe(2);
      // A late event against the dead channel must not raise.
      expect(
        await luaEval<boolean>(
          nvim,
          `require("glean.node").safe_rpcnotify(999, "gleanCommand", {})`,
        ),
      ).toBe(false);
    });
  });
});
