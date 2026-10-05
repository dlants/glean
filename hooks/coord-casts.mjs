#!/usr/bin/env node
import { execSync } from "node:child_process";
// Fails on casts to a coordinate brand outside the files allowed to mint them.
// Usage: coord-casts.mjs [files...] (defaults to all non-test node/**/*.ts).
import { readFileSync } from "node:fs";

const CAST =
  /\bas (Row|Lnum|ByteCol|ByteCol1|StrIdx|HeadLnum|WorktreeLnum|PostLnum|PreLnum)\b/;
// Base-brand helpers, RPC/nvim parsing boundaries, and the per-space narrowing
// sites (generic Lnum -> HeadLnum/PostLnum/... where the space is known from context).
const ALLOW = new Set([
  "node/core/types.ts",
  "node/core/diff.ts",
  "node/core/lineage.ts",
  "node/core/baseline.ts",
  "node/session/model.ts",
  "node/render/nav.ts",
  "node/render/commentActions.ts",
  "node/nvimAppUi.ts",
  "node/gutter/project.ts",
  "node/gutter/marking.ts",
  "node/gutter/fileGutter.ts",
  "node/overlay/overlay.ts",
  "node/view/review.ts",
  "node/view/jump.ts",
  "node/test/ui.ts",
]);
const isTest = (f) => /\.(test|typetest)\.ts$/.test(f);

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execSync("git ls-files 'node/*.ts'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
let bad = 0;
for (const f of files) {
  if (ALLOW.has(f) || isTest(f)) continue;
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (CAST.test(line)) {
        console.error(`${f}:${i + 1}: coordinate-brand cast: ${line.trim()}`);
        bad++;
      }
    });
}
if (bad) process.exit(1);
