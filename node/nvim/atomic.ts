import type { NeovimApi } from "./nvim-node/neovim-api.types.ts";

type Fns = NeovimApi["functions"];
export type AtomicCall = readonly [string, readonly unknown[]];

/** One `nvim_call_atomic` entry, type checked against the same param table as `nvim.call`. */
export function atomic<M extends keyof Fns>(
  method: M,
  args: Fns[M]["parameters"],
): AtomicCall {
  return [method, args];
}
