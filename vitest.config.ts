import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    pool: "forks",
    coverage: {
      reporter: ["text-summary"],
    },
  },
});
