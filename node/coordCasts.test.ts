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
});
