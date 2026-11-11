import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [{ format: "esm", syntax: "es2024", bundle: false, dts: false }],
  source: { entry: { index: ["./src/**/*.ts"] } },
  output: { target: "node", distPath: { root: "./lib" }, copy: [{ from: "./client/client.js", to: "client.js" }] },
});
