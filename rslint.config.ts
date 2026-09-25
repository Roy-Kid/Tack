import { defineConfig, js, ts } from "@rslint/core";

export default defineConfig([
  js.configs.recommended,
  ts.configs.recommended,
  {
    ignores: ["node_modules/**", "packages/*/lib/**"],
  },
]);
