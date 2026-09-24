/** Reads and validates glean's config out of nvim (`vim.g.glean_*`, `require("glean").config`). */
import type { OpenConfig } from "./app.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { LOG_PAGE_SIZE } from "./targets.ts";

export type NvimConfig = {
  root: string;
  dataDir: string;
  stateOverride: string | undefined;
  minSeenRun: number | undefined;
  ignoreWs: boolean;
};
const NVIM_CONFIG_LUA = `return { vim.fn.getcwd(), vim.fn.stdpath("data"), vim.g.glean_state_dir or vim.NIL, vim.g.glean_min_seen_run or vim.NIL, vim.g.glean_ignore_whitespace == true }`;
/** Validates the config tuple from nvim; vim.NIL arrives as null. */
export function parseNvimConfig(v: unknown): NvimConfig {
  if (!Array.isArray(v) || v.length !== 5) throw new Error("glean: bad config");
  const [root, dataDir, state, msr, ws] = v as unknown[];
  if (typeof root !== "string" || typeof dataDir !== "string")
    throw new Error("glean: bad config paths");
  return {
    root,
    dataDir,
    stateOverride: typeof state === "string" ? state : undefined,
    minSeenRun: typeof msr === "number" ? msr : undefined,
    ignoreWs: ws === true,
  };
}
export async function readNvimConfig(nvim: Nvim): Promise<NvimConfig> {
  return parseNvimConfig(
    await nvim.call("nvim_exec_lua", [NVIM_CONFIG_LUA, []]),
  );
}

const positive = (v: unknown, dflt: number) =>
  typeof v === "number" && v > 0 ? v : dflt;
/** Everything opening a review needs. */
export async function readOpenConfig(nvim: Nvim): Promise<OpenConfig> {
  const cfg = await readNvimConfig(nvim);
  // `glean_poll_ms`/`glean_log_page_size` exist so tests need not wait
  // out the live poll and can page a small fixture.
  const [bufName, defaultBase, hunkIndent, hunkIndentDelay, pollMs, page] =
    (await nvim.call("nvim_exec_lua", [
      `local c = require("glean").config
return { vim.api.nvim_buf_get_name(0), c.default_base, c.hunk_indent, c.hunk_indent_delay_ms, vim.g.glean_poll_ms, vim.g.glean_log_page_size }`,
      [],
    ])) as unknown[];
  return {
    ...cfg,
    cwd: cfg.root,
    bufName: typeof bufName === "string" ? bufName : "",
    defaultBase: typeof defaultBase === "string" ? defaultBase : "main",
    hunkIndent: typeof hunkIndent === "number" ? hunkIndent : 2,
    hunkIndentDelayMs:
      typeof hunkIndentDelay === "number" ? hunkIndentDelay : 50,
    pollMs: positive(pollMs, 1000),
    logPageSize: positive(page, LOG_PAGE_SIZE),
  };
}
