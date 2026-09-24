import { describe, expect, it } from "vitest";
import { parseListEvent, storePaths } from "./app.ts";
import { parseCommand } from "./glean.ts";

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
