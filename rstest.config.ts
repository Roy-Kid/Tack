import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["tests/**/*.test.ts"],
  testEnvironment: "node",
  testTimeout: 120_000,
  hookTimeout: 60_000,
  // Integration tests boot the full runtime; keep them serial.
  pool: { maxWorkers: 1 },
});
