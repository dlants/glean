import { createHash } from "node:crypto";
import { join } from "node:path";
import { Git, spawnRunner } from "./git/git.ts";
import { FileGutter, parseGutterEvent } from "./gutter/fileGutter.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { Session } from "./session/session.ts";
import { parseAction, ReviewView } from "./view/view.ts";

export const GLEAN_COMMAND = "gleanCommand";
export const GLEAN_ACTION = "gleanAction";
export const GLEAN_GUTTER = "gleanGutter";
const views = new Map<number, ReviewView>();
/** The live review the file-buffer gutter follows: the most recently opened. */
let liveSession: Session | undefined;
let gutter: FileGutter | undefined;

type Command =
  | { kind: "ping" }
  | { kind: "open"; base: string }
  | { kind: "toggle-gutter" }
  | { kind: "unknown"; args: readonly string[] };

export function parseCommand(args: unknown): Command {
  if (
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string")
  ) {
    return { kind: "unknown", args: [] };
  }
  if (args[0] === "ping") return { kind: "ping" };
  if (args[0] === "toggle-gutter") return { kind: "toggle-gutter" };
  if (args[0] === "open") return { kind: "open", base: args[1] ?? "HEAD" };
  return { kind: "unknown", args };
}

async function handleCommand(nvim: Nvim, command: Command): Promise<void> {
  switch (command.kind) {
    case "ping":
      await nvim.call("nvim_exec_lua", [
        `vim.g.glean_pong = (vim.g.glean_pong or 0) + 1
vim.notify("glean: pong")`,
        [],
      ]);
      return;
    case "open":
      await openReview(nvim, command.base);
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

type OpenConfig = {
  root: string;
  dataDir: string;
  stateOverride: string | undefined;
  minSeenRun: number | undefined;
  ignoreWs: boolean;
};
/** Validates the config tuple from nvim; vim.NIL arrives as null. */
export function parseOpenConfig(v: unknown): OpenConfig {
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
async function openReview(nvim: Nvim, base: string): Promise<void> {
  const { root, dataDir, stateOverride, minSeenRun, ignoreWs } =
    parseOpenConfig(
      await nvim.call("nvim_exec_lua", [
        `return { vim.fn.getcwd(), vim.fn.stdpath("data"), vim.g.glean_state_dir or vim.NIL, vim.g.glean_min_seen_run or vim.NIL, vim.g.glean_ignore_whitespace == true }`,
        [],
      ]),
    );
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  const stateDir =
    stateOverride ??
    join(
      dataDir,
      "glean-node",
      createHash("sha256").update(root).digest("hex").slice(0, 16),
    );
  const session = new Session({
    git,
    base,
    target: { kind: "worktree" },
    stateDir,
    build: { ignoreWhitespace: ignoreWs },
  });
  const bufnr = (await nvim.call("nvim_exec_lua", [
    `return require("glean.node").open_review_buffer()`,
    [],
  ])) as number;
  const view = new ReviewView(nvim, bufnr, session, {
    minSeenRun: typeof minSeenRun === "number" ? minSeenRun : 5,
    ignoreWhitespace: ignoreWs,
  });
  await view.init();
  views.set(bufnr, view);
  liveSession = session;
  session.subscribe(() => {
    if (liveSession === session) void gutter?.refreshAll();
  });
  await session.refresh();
  session.startLive(1000);
}

export async function startGlean(nvim: Nvim): Promise<void> {
  // Handlers go in before the bridge so no notification can arrive unhandled.
  nvim.onNotification(GLEAN_COMMAND, async (args: unknown[]) => {
    try {
      await handleCommand(nvim, parseCommand(args[0]));
    } catch (err) {
      nvim.logger.error(err instanceof Error ? err : String(err));
    }
  });
  const g = new FileGutter(nvim, () => liveSession);
  await g.init();
  gutter = g;
  nvim.onNotification(GLEAN_GUTTER, async (args: unknown[]) => {
    const ev = parseGutterEvent(args[0]);
    if (ev) await g.handle(ev);
  });
  nvim.onNotification(GLEAN_ACTION, async (args: unknown[]) => {
    try {
      const view = views.get(Number(args[0]));
      const action = parseAction(args[1]);
      if (view && action) await view.dispatch(action);
    } catch (err) {
      nvim.logger.error(err instanceof Error ? err : String(err));
    }
  });
  await nvim.call("nvim_exec_lua", [
    `require("glean.node").bridge(...)`,
    [nvim.channelId],
  ]);
}
