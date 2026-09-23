import { createHash } from "node:crypto";
import { join } from "node:path";
import { Git, spawnRunner } from "./git/git.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { Session } from "./session/session.ts";
import { parseAction, ReviewView } from "./view/view.ts";

export const GLEAN_COMMAND = "gleanCommand";
export const GLEAN_ACTION = "gleanAction";
const views = new Map<number, ReviewView>();

type Command =
  | { kind: "ping" }
  | { kind: "open"; base: string }
  | { kind: "unknown"; args: readonly string[] };

export function parseCommand(args: unknown): Command {
  if (
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string")
  ) {
    return { kind: "unknown", args: [] };
  }
  if (args[0] === "ping") return { kind: "ping" };
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
    case "unknown":
      await nvim.call("nvim_notify", [
        `glean: unknown command ${JSON.stringify(command.args)}`,
        3,
        {},
      ]);
      return;
  }
}

async function openReview(nvim: Nvim, base: string): Promise<void> {
  const [root, dataDir, stateOverride, minSeenRun, ignoreWs] = (await nvim.call(
    "nvim_exec_lua",
    [
      `return { vim.fn.getcwd(), vim.fn.stdpath("data"), vim.g.glean_state_dir or vim.NIL, vim.g.glean_min_seen_run or vim.NIL, vim.g.glean_ignore_whitespace == true }`,
      [],
    ],
  )) as [string, string, string | null, number | null, boolean];
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
