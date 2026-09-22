import { startGlean } from "./glean.ts";
import { notifyErr } from "./nvim/nvim.ts";
import { attach, type LogLevel } from "./nvim/nvim-node/index.ts";

const socket = process.env.NVIM;
if (!socket) throw new Error("glean: NVIM socket missing");

const nvim = await attach({
  socket,
  client: { name: "glean" },
  logging: { level: (process.env.LOG_LEVEL ?? "info") as LogLevel },
});

// nvim's jobstop sends SIGTERM; exit immediately rather than waiting on
// open handles so :qa stays instant.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => process.exit(0));
}

process.on("uncaughtException", (error) => {
  nvim.logger.error(error);
  notifyErr(nvim, error).catch(() => undefined);
});

await startGlean(nvim);
