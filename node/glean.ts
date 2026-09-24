import { basename } from "node:path";
import { Api, ApiError } from "./api/api.ts";
import {
  App,
  type AppUi,
  type Command,
  parseListEvent,
  repoRelative,
  storeLocation,
} from "./app.ts";
import { Store } from "./core/state.ts";
import type { WorktreeLnum } from "./core/types.ts";
import { Git, spawnRunner } from "./git/git.ts";
import { FileGutter, parseGutterEvent } from "./gutter/fileGutter.ts";
import { NvimGutterUi } from "./gutter/nvimGutterUi.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { NvimOverlayUi } from "./overlay/nvimOverlayUi.ts";
import { Overlay, parseOverlayEvent } from "./overlay/overlay.ts";
import {
  isPrArg,
  LOG_PAGE_SIZE,
  spawnGhRunner,
  TargetError,
} from "./targets.ts";
import { parseAction, parseQuery, ReviewView } from "./view/view.ts";

export const GLEAN_COMMAND = "gleanCommand";
export const GLEAN_ACTION = "gleanAction";
export const GLEAN_GUTTER = "gleanGutter";
export const GLEAN_API = "gleanApi";
export const GLEAN_LIST = "gleanList";
export const GLEAN_QUERY = "gleanQuery";
export const GLEAN_OVERLAY = "gleanOverlay";
let app: App | undefined;
let gutter: FileGutter | undefined;
let overlay: Overlay | undefined;
/** A store write from repo mode (api, overlay): live reviews of the repo
 * re-read it, and file buffers re-stamp their comments. */
function afterRepoWrite(root: string) {
  void Promise.all(
    (app?.reviews ?? [])
      .filter((r) => r.session.repoRoot === root)
      .map((r) => r.session.refresh()),
  ).catch(() => undefined);
}

type GleanCommand =
  | Command
  | { kind: "ping" }
  | { kind: "toggle-gutter" }
  | { kind: "unknown"; args: readonly string[] };

/** The `:Glean` forms of the Lua `M.setup` dispatch. `open [base]` is kept as
 * an alias of `:Glean [base]`. */
export function parseCommand(args: unknown): GleanCommand {
  if (
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string")
  ) {
    return { kind: "unknown", args: [] };
  }
  const [a0, a1] = args;
  switch (a0) {
    case undefined:
      return { kind: "dirty", base: undefined };
    case "ping":
    case "log":
    case "prs":
    case "toggle-gutter":
    case "jump":
      return { kind: a0 };
    case "open":
      return { kind: "dirty", base: a1 };
    case "pr":
      return { kind: "pr", pr: a1 };
    case "branch":
      return { kind: "branch", branch: a1 };
    case "comment":
    case "comments":
      return { kind: "unknown", args };
  }
  if (args.length === 1)
    return isPrArg(a0) ? { kind: "pr", pr: a0 } : { kind: "dirty", base: a0 };
  if (a1 !== undefined) return { kind: "range", base: a0, target: a1 };
  return { kind: "unknown", args };
}

async function handleCommand(nvim: Nvim, command: GleanCommand): Promise<void> {
  switch (command.kind) {
    case "ping":
      await nvim.call("nvim_exec_lua", [
        `vim.g.glean_pong = (vim.g.glean_pong or 0) + 1
vim.notify("glean: pong")`,
        [],
      ]);
      return;
    case "dirty":
    case "range":
    case "pr":
    case "branch":
    case "log":
    case "prs":
    case "jump":
      await app?.command(command);
      return;
    case "toggle-gutter": {
      if (!gutter) return;
      await gutter.setEnabled(!gutter.enabled);
      await nvim.call("nvim_notify", [
        `glean: gutter ${gutter.enabled ? "on" : "off"}`,
        2,
        {},
      ]);
      return;
    }
    case "unknown":
      await nvim.call("nvim_notify", [
        `glean: unknown command ${JSON.stringify(command.args)}`,
        3,
        {},
      ]);
      return;
  }
}

type NvimConfig = {
  root: string;
  dataDir: string;
  stateOverride: string | undefined;
  minSeenRun: number | undefined;
  ignoreWs: boolean;
};
/** Validates the config tuple from nvim; vim.NIL arrives as null. */
export function parseOpenConfig(v: unknown): NvimConfig {
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
/** Resolved `rev-parse --show-toplevel` per probe path, so repeat repo-mode calls skip git. */
const repoRoots = new Map<string, string>();
/** Repo mode: the store of the repo containing `path` (default: nvim's cwd).
 * The store is re-read each call: live sessions write the same shards. */
async function repoContext(nvim: Nvim, path: string | undefined) {
  const {
    root: cwd,
    dataDir,
    stateOverride,
  } = parseOpenConfig(await nvim.call("nvim_exec_lua", [OPEN_CONFIG_LUA, []]));
  const probePath = path ?? cwd;
  let root = repoRoots.get(probePath);
  if (root === undefined) {
    const probe = new Git({ repoRoot: probePath, runner: spawnRunner() });
    const top = await probe.run(["rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok")
      throw new ApiError(`glean: ${probePath} is not inside a git repository`);
    root = top.value.trim();
    repoRoots.set(probePath, root);
  }
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  const loc = await storeLocation(git, dataDir, stateOverride);
  const store = new Store(loc.stateDir, loc.wtShard);
  await store.load([]);
  return { root, git, store };
}

const OPEN_CONFIG_LUA = `return { vim.fn.getcwd(), vim.fn.stdpath("data"), vim.g.glean_state_dir or vim.NIL, vim.g.glean_min_seen_run or vim.NIL, vim.g.glean_ignore_whitespace == true }`;

const num = (v: unknown, dflt: number) =>
  typeof v === "number" && v > 0 ? v : dflt;

/** `AppUi` over nvim: config reads, buffer/window ops, list painting. */
function nvimAppUi(nvim: Nvim): AppUi {
  const lua = (code: string, args: unknown[] = []) =>
    nvim.call("nvim_exec_lua", [code, args]);
  return {
    async config() {
      const cfg = parseOpenConfig(await lua(OPEN_CONFIG_LUA));
      // `glean_poll_ms`/`glean_log_page_size` exist so tests need not wait
      // out the live poll and can page a small fixture.
      const [bufName, defaultBase, hunkIndent, hunkIndentDelay, pollMs, page] =
        (await lua(`local c = require("glean").config
return { vim.api.nvim_buf_get_name(0), c.default_base, c.hunk_indent, c.hunk_indent_delay_ms, vim.g.glean_poll_ms, vim.g.glean_log_page_size }`)) as unknown[];
      return {
        ...cfg,
        cwd: cfg.root,
        bufName: typeof bufName === "string" ? bufName : "",
        defaultBase: typeof defaultBase === "string" ? defaultBase : "main",
        hunkIndent: typeof hunkIndent === "number" ? hunkIndent : 2,
        hunkIndentDelayMs:
          typeof hunkIndentDelay === "number" ? hunkIndentDelay : 50,
        pollMs: num(pollMs, 1000),
        logPageSize: num(page, LOG_PAGE_SIZE),
      };
    },
    async cursorFile() {
      const [name, lnum] = (await lua(
        `return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }`,
      )) as [string, number];
      return { name, lnum: lnum as WorktreeLnum };
    },
    async bufValid(buf) {
      return (await nvim.call("nvim_buf_is_valid", [buf])) as boolean;
    },
    async openReviewBuffer(title) {
      return (await lua(
        `return require("glean.node").open_review_buffer(...)`,
        [title],
      )) as number;
    },
    async renameBuffer(buf, title) {
      await lua(`pcall(vim.api.nvim_buf_set_name, ...)`, [buf, title]);
    },
    async showBuffer(buf) {
      await lua(`require("glean.node").show_buffer(...)`, [buf]);
    },
    async wipeBuffer(buf) {
      await lua(`pcall(vim.api.nvim_buf_delete, ..., { force = true })`, [buf]);
    },
    async blankBuffer(buf) {
      await lua(
        `local buf = ...
for _, ns in pairs(vim.api.nvim_get_namespaces()) do
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
vim.bo[buf].modifiable = false`,
        [buf],
      );
    },
    async setCursor(buf, row) {
      await lua(
        `local buf, row = ...
for _, win in ipairs(vim.fn.win_findbuf(buf)) do
  pcall(vim.api.nvim_win_set_cursor, win, { math.min(row + 1, vim.api.nvim_buf_line_count(buf)), 0 })
end`,
        [buf, row],
      );
    },
    async openListBuffer(kind, root) {
      return (await lua(`return require("glean.node").open_list_buffer(...)`, [
        kind,
        `Glean:${basename(root)} ${kind}`,
      ])) as number;
    },
    async paintList(buf, frame) {
      await lua(
        `local buf, lines, hls = ...
local ns = vim.api.nvim_create_namespace("glean_list")
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.bo[buf].modifiable = false
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
for i, h in ipairs(hls) do
  local group = (i == 1) and "GleanModeHeader" or "GleanCommitHeader"
  if h[2] < 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_row = h[1] + 1, hl_group = group, hl_eol = true })
  else
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_col = h[2], hl_group = group })
  end
end`,
        [
          buf,
          frame.lines,
          frame.highlights.map((h) => [
            h.row,
            h.endCol === "eol" ? -1 : h.endCol,
          ]),
        ],
      );
    },
    async notify(msg, level) {
      await nvim.call("nvim_notify", [
        msg,
        level === "error" ? 4 : level === "warn" ? 3 : 2,
        {},
      ]);
    },
    review(buf, session, opts) {
      return new ReviewView(nvim, buf, session, opts);
    },
  };
}

async function notifyError(nvim: Nvim, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await nvim.call("nvim_notify", [msg, 4, {}]);
}

/** User-facing failures become error notifications; anything else is logged. */
async function reported(nvim: Nvim, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TargetError) await notifyError(nvim, err);
    else nvim.logger.error(err instanceof Error ? err : String(err));
  }
}

export async function startGlean(nvim: Nvim): Promise<void> {
  // Handlers go in before the bridge so no notification can arrive unhandled.
  nvim.onNotification(GLEAN_COMMAND, async (args: unknown[]) => {
    await reported(nvim, () => handleCommand(nvim, parseCommand(args[0])));
  });
  nvim.onNotification(GLEAN_LIST, async (args: unknown[]) => {
    const ev = parseListEvent(args[0]);
    if (ev) await reported(nvim, async () => app?.list(ev));
  });
  const a = new App(nvimAppUi(nvim), {
    runner: spawnRunner(),
    gh: (root) => spawnGhRunner(root),
    onModel: ({ gutter: g, overlay: o }) => {
      if (g) void gutter?.refreshAll();
      if (o) void overlay?.refreshAll();
    },
  });
  app = a;
  const gutterUi = new NvimGutterUi(nvim);
  await gutterUi.init();
  const g = new FileGutter(gutterUi, () => a.liveSession);
  gutter = g;
  nvim.onNotification(GLEAN_GUTTER, async (args: unknown[]) => {
    const ev = parseGutterEvent(args[0]);
    if (ev) await g.handle(ev);
  });
  const overlayUi = new NvimOverlayUi(nvim);
  await overlayUi.init();
  const o = new Overlay(overlayUi, {
    repoContext: (dir) => repoContext(nvim, dir),
    repoRelative,
    pushUndo: (buf, seq, a) => g.push(buf, seq, a),
    afterWrite: afterRepoWrite,
  });
  overlay = o;
  nvim.onNotification(GLEAN_OVERLAY, async (args: unknown[]) => {
    const ev = parseOverlayEvent(args[0]);
    if (!ev) return;
    if (ev.kind === "editor-submit" || ev.kind === "pick") overlayUi.submit(ev);
    else await o.handle(ev);
  });
  nvim.onNotification(GLEAN_ACTION, async (args: unknown[]) => {
    try {
      const bufnr = args[0];
      const action = parseAction(args[1]);
      if (typeof bufnr !== "number" || !action) return;
      await a.action(bufnr, action);
    } catch (err) {
      nvim.logger.error(err instanceof Error ? err : String(err));
    }
  });
  nvim.onRequest(GLEAN_QUERY, async (args: unknown[]) => {
    const q = parseQuery(args[1]);
    const view = typeof args[0] === "number" ? a.view(args[0]) : undefined;
    return (q && view?.query(q)) ?? null;
  });
  const api = new Api({
    reviews: () => a.reviews,
    repoContext: (path) => repoContext(nvim, path),
    afterRepoWrite: (root) => {
      afterRepoWrite(root);
      void o.refreshAll();
    },
  });
  // Errors travel back as the rpcrequest error, so the Lua caller sees them raised.
  nvim.onRequest(GLEAN_API, async (args: unknown[]) => {
    const out = await api.call(args[0], args[1]);
    return out === undefined ? null : out;
  });
  await nvim.call("nvim_exec_lua", [
    `require("glean.node").bridge(...)`,
    [nvim.channelId],
  ]);
}
