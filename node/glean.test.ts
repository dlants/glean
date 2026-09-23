import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand, parseListEvent, storePaths } from "./glean.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { luaEval, pollUntil, startBackend, withNvim } from "./test/driver.ts";
import { makeRepo } from "./test/repo.ts";

describe("parseCommand", () => {
  it("recognizes ping and rejects non-string args", () => {
    expect(parseCommand(["ping"])).toEqual({ kind: "ping" });
    expect(parseCommand([])).toEqual({ kind: "dirty", base: undefined });
    expect(parseCommand(["main"])).toEqual({ kind: "dirty", base: "main" });
    expect(parseCommand(["open", "main"])).toEqual({
      kind: "dirty",
      base: "main",
    });
    expect(parseCommand(["a", "b"])).toEqual({
      kind: "range",
      base: "a",
      target: "b",
    });
    expect(parseCommand(["42"])).toEqual({ kind: "pr", pr: "42" });
    expect(
      parseCommand(["https://github.com/acme/widgets/pull/42/files"]),
    ).toEqual({
      kind: "pr",
      pr: "https://github.com/acme/widgets/pull/42/files",
    });
    expect(parseCommand(["pr"])).toEqual({ kind: "pr", pr: undefined });
    expect(parseCommand(["branch", "f/x"])).toEqual({
      kind: "branch",
      branch: "f/x",
    });
    expect(parseCommand(["log"])).toEqual({ kind: "log" });
    expect(parseCommand(["prs"])).toEqual({ kind: "prs" });
    // Like the Lua dispatch, extra args past the target are ignored.
    expect(parseCommand(["a", "b", "c"])).toEqual({
      kind: "range",
      base: "a",
      target: "b",
    });
    expect(parseCommand([1])).toEqual({ kind: "unknown", args: [] });
  });
});

describe("node bridge", () => {
  it(":Glean ping reaches node and node answers", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      await nvim.call("nvim_command", ["Glean ping"]);
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
        (await luaEval<number>(nvim, `vim.fn.exists(":Glean")`)) === 0
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
describe("storePaths", () => {
  const ok = <T>(value: T) => ({ kind: "ok" as const, value });
  const err = { kind: "error" as const, message: "x" };
  it("hashes the git common dir like the Lua store", () => {
    // sha256("/repo/.git")[:16], as vim.fn.sha256 computed it.
    expect(
      storePaths("/data", undefined, ok("/repo/.git"), ok("main")),
    ).toEqual({
      stateDir: "/data/glean/6b4ca2db35cfaf43",
      wtShard: "WORKTREE/main",
    });
  });
  it("falls back to <data>/glean and WORKTREE/HEAD", () => {
    expect(storePaths("/data", undefined, err, err)).toEqual({
      stateDir: "/data/glean",
      wtShard: "WORKTREE/HEAD",
    });
    expect(storePaths("/data", undefined, err, ok(undefined)).wtShard).toBe(
      "WORKTREE/HEAD",
    );
    expect(storePaths("/data", undefined, err, ok("HEAD")).wtShard).toBe(
      "WORKTREE/HEAD",
    );
  });
  it("honours the override dir", () => {
    expect(storePaths("/data", "/s", ok("/repo/.git"), ok("b")).stateDir).toBe(
      "/s",
    );
  });
});

describe("parseListEvent", () => {
  it("accepts well-formed events", () => {
    expect(parseListEvent({ kind: "open", buf: 3, srow: 1, erow: 2 })).toEqual({
      kind: "open",
      buf: 3,
      srow: 1,
      erow: 2,
    });
    expect(parseListEvent({ kind: "page", buf: 3, delta: -1 })).toEqual({
      kind: "page",
      buf: 3,
      delta: -1,
    });
    expect(parseListEvent({ kind: "reload", buf: 3 })).toEqual({
      kind: "reload",
      buf: 3,
    });
    expect(parseListEvent({ kind: "gone", buf: 3 })).toEqual({
      kind: "gone",
      buf: 3,
    });
  });
  it("rejects missing or non-numeric fields", () => {
    expect(parseListEvent(undefined)).toBeUndefined();
    expect(parseListEvent("open")).toBeUndefined();
    expect(parseListEvent({ kind: "open", srow: 1, erow: 1 })).toBeUndefined();
    expect(parseListEvent({ kind: "open", buf: 1, srow: "1", erow: 1 })).toBe(
      undefined,
    );
    expect(parseListEvent({ kind: "page", buf: 1 })).toBeUndefined();
    expect(parseListEvent({ kind: "nope", buf: 1 })).toBeUndefined();
  });
});
describe("review targets (driver)", () => {
  const setup = async (nvim: Nvim, root: string) => {
    const stateDir = mkdtempSync(join(tmpdir(), "glean-targets-"));
    await luaEval(
      nvim,
      `(function() vim.cmd.cd(${JSON.stringify(root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
    );
    await startBackend(nvim);
  };
  const bufName = () =>
    "vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':t')";
  const lines = (nvim: Nvim) =>
    luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");

  it(":Glean <base> <target> reviews the commit range under the old title", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n" } },
      { msg: "one", files: { "a.txt": "ONE\n" } },
      { msg: "two", files: { "b.txt": "B\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      const [b, t] = [repo.shas[0] ?? "", repo.shas[1] ?? ""];
      await nvim.call("nvim_command", [`Glean ${b} ${t}`]);
      const name = await pollUntil(async () => {
        const n = await luaEval<string>(nvim, bufName());
        return n.startsWith("Glean:g") ? n : undefined;
      });
      expect(name).toBe(
        `Glean:g1 ${basename(repo.root)} ${b.slice(0, 8)}..${t.slice(0, 8)}`,
      );
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.some((s) => s.includes("ONE")) ? l : undefined;
      });
      expect(body.join("\n")).not.toContain("b.txt");
    });
  });

  it(":Glean log → <CR> opens the selected commit, one review at a time", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n" } },
      { msg: "c1: one", files: { "a.txt": "ONE\n" } },
      { msg: "c2: two", files: { "b.txt": "B\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", ["Glean log"]);
      const log = await pollUntil(async () => {
        const l = await lines(nvim);
        return l[0]?.startsWith("Glean log") ? l : undefined;
      });
      expect(log[1]).toContain("uncommitted changes");
      expect(log[2]).toContain("c2: two");
      expect(await luaEval<string>(nvim, bufName())).toBe(
        `Glean:${basename(repo.root)} log`,
      );
      // Row 4 is c1: its review contains only a.txt.
      await nvim.call("nvim_win_set_cursor", [0, [4, 0]]);
      await nvim.call("nvim_input", ["<CR>"]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.some((s) => s.includes("ONE")) ? l : undefined;
      });
      expect(body.join("\n")).not.toContain("b.txt");
      const short = repo.shas[1]?.slice(0, 8);
      expect(await luaEval<string>(nvim, bufName())).toContain(`${short} [`);
      // Back to the log, visual <CR> over both commits replaces the review.
      await nvim.call("nvim_command", ["b #"]);
      await nvim.call("nvim_win_set_cursor", [0, [3, 0]]);
      await nvim.call("nvim_input", ["Vj<CR>"]);
      await pollUntil(async () => {
        const l = await lines(nvim);
        return l.some((s) => s.includes("b.txt")) &&
          l.some((s) => s.includes("a.txt"))
          ? l
          : undefined;
      });
      const sessions = await luaEval<unknown[]>(
        nvim,
        `require("glean.api").sessions()`,
      );
      expect(sessions).toHaveLength(1);
    });
  });
  it(":Glean log pages forward, stops at the end, and survives a wipe", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "0\n" } },
      ...[1, 2, 3, 4].map((i) => ({
        msg: `c${i}`,
        files: { "a.txt": `${i}\n` },
      })),
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await luaEval(nvim, "(function() vim.g.glean_log_page_size = 2 end)()");
      await nvim.call("nvim_command", ["Glean log"]);
      const commitRows = (l: string[]) =>
        l.filter((s) => /^[0-9a-f]{7,} /.test(s));
      const first = await pollUntil(async () => {
        const l = await lines(nvim);
        return l[0]?.startsWith("Glean log") ? l : undefined;
      });
      expect(commitRows(first).map((s) => s.split("  ")[1])).toEqual([
        "c4",
        "c3",
      ]);
      expect(first.at(-1)).toContain("]p to load more");
      await nvim.call("nvim_input", ["]p"]);
      const second = await pollUntil(async () => {
        const l = await lines(nvim);
        return commitRows(l).length === 4 ? l : undefined;
      });
      expect(commitRows(second).map((s) => s.split("  ")[1])).toEqual([
        "c4",
        "c3",
        "c2",
        "c1",
      ]);
      expect(second.at(-1)).toContain("]p to load more");
      await nvim.call("nvim_input", ["]p"]);
      const last = await pollUntil(async () => {
        const l = await lines(nvim);
        return commitRows(l).length === 5 ? l : undefined;
      });
      expect(last.at(-1)).not.toContain("]p to load more");
      await nvim.call("nvim_input", ["]p"]);
      await new Promise((r) => setTimeout(r, 200));
      expect(commitRows(await lines(nvim))).toHaveLength(5);
      // A wiped list buffer is forgotten: the next :Glean log makes a fresh one.
      const oldBuf = await luaEval<number>(
        nvim,
        "vim.api.nvim_get_current_buf()",
      );
      await nvim.call("nvim_command", [`bwipeout! ${oldBuf}`]);
      await nvim.call("nvim_command", ["Glean log"]);
      const fresh = await pollUntil(async () => {
        const b = await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()");
        const l = await lines(nvim);
        return b !== oldBuf && l[0]?.startsWith("Glean log") ? l : undefined;
      });
      expect(commitRows(fresh)).toHaveLength(2);
    });
  });
});
