import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["pi/**"],
    testTimeout: 20_000,
    pool: "forks",
    coverage: {
      exclude: ["pi/**", "node_modules/@mariozechner/pi-*/**"],
      reporter: ["text-summary"],
    },
  },
});
