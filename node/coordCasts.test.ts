import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../hooks/coord-casts.mjs");

describe("coord-casts check", () => {
  it("passes on the repo", () => {
    expect(spawnSync("node", [script]).status).toBe(0);
  });
  it("fails on a stray cast outside the allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    mkdirSync(join(dir, "node"));
    writeFileSync(join(dir, "node/x.ts"), "const r = 1 as Row;\n");
    const r = spawnSync("node", [script, "node/x.ts"], { cwd: dir });
    expect(r.status).toBe(1);
  });
  it("catches multi-line and angle-bracket casts, exempts tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    mkdirSync(join(dir, "node"));
    writeFileSync(join(dir, "node/a.ts"), "const r = 1 as\n  Lnum;\n");
    writeFileSync(join(dir, "node/b.ts"), "const r = <Row>x;\n");
    writeFileSync(join(dir, "node/x.test.ts"), "const r = 1 as Row;\n");
    const run = (f: string) =>
      spawnSync("node", [script, f], { cwd: dir }).status;
    expect(run("node/a.ts")).toBe(1);
    expect(run("node/b.ts")).toBe(1);
    expect(run("node/x.test.ts")).toBe(0);
  });
});
