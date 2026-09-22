import type { Nvim } from "./nvim/nvim-node/index.ts";

export const GLEAN_COMMAND = "gleanCommand";

type Command = { kind: "ping" } | { kind: "unknown"; args: readonly string[] };

export function parseCommand(args: unknown): Command {
  if (
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string")
  ) {
    return { kind: "unknown", args: [] };
  }
  if (args[0] === "ping") return { kind: "ping" };
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
    case "unknown":
      await nvim.call("nvim_notify", [
        `glean: unknown command ${JSON.stringify(command.args)}`,
        3,
        {},
      ]);
      return;
  }
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
  await nvim.call("nvim_exec_lua", [
    `require("glean.node").bridge(...)`,
    [nvim.channelId],
  ]);
}
