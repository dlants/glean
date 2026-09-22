import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attach, type Nvim } from "../nvim/nvim-node/index.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Spawn a headless nvim with glean on the runtimepath, attach a test
 * client over its socket, and tear both down afterwards. The glean node
 * backend is not started; tests call `require("glean.node").start()`. */
export async function withNvim<T>(fn: (nvim: Nvim) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "glean-test-"));
  const sock = path.join(dir, "nvim.sock");
  const proc = spawn(
    "nvim",
    [
      "--headless",
      "--clean",
      "-n",
      "--listen",
      sock,
      "--cmd",
      `set rtp^=${repoRoot}`,
    ],
    { cwd: dir, env: { ...process.env, GLEAN_DEV: "1" } },
  );
  try {
    const nvim = await attachWhenReady(sock);
    try {
      return await fn(nvim);
    } finally {
      nvim.detach();
    }
  } finally {
    proc.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}

async function attachWhenReady(sock: string): Promise<Nvim> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await attach({ socket: sock, client: { name: "glean-test" } });
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(20);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await sleep(25);
  }
}

export async function luaEval<T>(nvim: Nvim, expr: string): Promise<T> {
  return (await nvim.call("nvim_exec_lua", [`return ${expr}`, []])) as T;
}

/** Start the glean backend and wait for it to bridge back. */
export async function startBackend(nvim: Nvim): Promise<number> {
  await luaEval(nvim, `require("glean.node").start()`);
  return pollUntil(() =>
    luaEval<number | null>(nvim, "vim.g.glean_node_channel").then(
      (c) => c ?? undefined,
    ),
  );
}
