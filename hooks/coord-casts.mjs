#!/usr/bin/env node
import { execSync } from "node:child_process";
// Fails on casts to a coordinate brand outside the files allowed to mint them.
// Usage: coord-casts.mjs [files...] (defaults to all non-test node/**/*.ts).
import { readFileSync } from "node:fs";

const BRANDS =
  "Row|Lnum|ByteCol|ByteCol1|StrIdx|HeadLnum|WorktreeLnum|PostLnum|PreLnum";
// `as Brand` (also split across lines) and `<Brand>x` angle-bracket casts.
const CAST = new RegExp(
  `\\bas\\s+(${BRANDS})\\b|(?<![\\w$.])<(${BRANDS})>\\s*[\\w(]`,
  "g",
);
// Only the minting helpers (toRow, lnumAt, worktreeLnum, ...) may cast; every
// other file names the conversion through one of them.
const ALLOW = new Set(["node/core/types.ts"]);
const isTest = (f) => /\.(test|typetest)\.ts$/.test(f);

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execSync("git ls-files 'node/*.ts'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
let bad = 0;
for (const f of files) {
  if (ALLOW.has(f) || isTest(f)) continue;
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(CAST)) {
    const line = text.slice(0, m.index).split("\n").length;
    console.error(`${f}:${line}: coordinate-brand cast: ${m[0].trim()}`);
    bad++;
  }
}
if (bad) process.exit(1);
