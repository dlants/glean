#!/usr/bin/env node
// Bundle the node backend into a single ESM file so startup opens one file
// instead of the whole node_modules tree.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const banner =
  "import { createRequire as __createRequire } from 'module'; " +
  "const require = __createRequire(import.meta.url);";
const cmd = [
  "npx",
  "esbuild",
  "node/index.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${join("dist", "glean.mjs")}`,
  `--banner:js=${JSON.stringify(banner)}`,
  "--external:@msgpackr-extract/*",
].join(" ");
console.log(`> ${cmd}`);
execSync(cmd, { stdio: "inherit", cwd: root });
