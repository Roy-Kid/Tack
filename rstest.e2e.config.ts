import { defineConfig } from "@rstest/core";

/** Browser tests: `npm run test:e2e` (needs Chromium; see tests/e2e). */
export default defineConfig({
  include: ["tests/e2e/**/*.test.ts"],
  testEnvironment: "node",
  testTimeout: 120_000,
  hookTimeout: 120_000,
  pool: { maxWorkers: 1 },
});
