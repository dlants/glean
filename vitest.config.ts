/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["node/**/*.test.ts"],
    // Each driver test spawns its own nvim; cap parallelism to bound memory.
    // Git-backed tests spawn many processes; under parallel load 5 s is too tight.
    testTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
