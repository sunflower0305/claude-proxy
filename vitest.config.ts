import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 15000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reportsDirectory: "./coverage",
      reporter: ["text", "lcov"],
    },
  },
});
