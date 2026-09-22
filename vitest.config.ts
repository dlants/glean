/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["node/**/*.test.ts"],
    // Each driver test spawns its own nvim; cap parallelism to bound memory.
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
