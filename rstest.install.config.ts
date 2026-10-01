import { defineConfig } from "@rstest/core";

/** Install-from-source smoke test: `npm run test:install` (a clean `npm ci` and build; a few minutes). */
export default defineConfig({
  include: ["tests/install/**/*.test.ts"],
  testEnvironment: "node",
  testTimeout: 180_000,
  hookTimeout: 900_000,
  pool: { maxWorkers: 1 },
});
