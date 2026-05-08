import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**", "coverage/**", "node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "coverage/**", "node_modules/**"],
  },
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
  pack: {
    entry: "src/proxy.ts",
    format: ["esm"],
    dts: true,
    target: "node20.12",
    platform: "node",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    deps: {
      neverBundle: ["express"],
    },
  },
});
