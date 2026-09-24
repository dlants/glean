/** `:Glean <args>`: parsing and dispatch. */
import type { App, Command } from "./app.ts";
import type { FileGutter } from "./gutter/fileGutter.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { isPrArg } from "./targets.ts";

export type GleanCommand =
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

export async function handleCommand(
  deps: { nvim: Nvim; app: App; gutter: FileGutter },
  command: GleanCommand,
): Promise<void> {
  const { nvim, app, gutter } = deps;
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
      await app.command(command);
      return;
    case "toggle-gutter": {
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
