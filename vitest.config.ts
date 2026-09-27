import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // A temporary HOME and no keys or Claude Code variables from this machine (test/setup.ts).
    setupFiles: ["test/setup.ts"],
    // Every run and every failure is appended to test-results/ (test/failure-reporter.ts).
    reporters: ["default", "./test/failure-reporter.ts"],
  },
});
