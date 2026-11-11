import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      format: "esm",
      syntax: "es2024",
      bundle: false,
      dts: false,
      source: { entry: { index: ["./src/**/*.ts"] } },
      output: { target: "node", externals: [/^@deepseek-ai\//, /^@tack\//, /^zod/] },
    },
    {
      format: "cjs",
      bundle: true,
      dts: false,
      source: { entry: { client: "./client/index.jsx" }, define: { "process.env.NODE_ENV": JSON.stringify("production") } },
      output: { target: "web", autoExternal: false, injectStyles: true, externals: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], filename: { js: "[name].js" }, copy: [{ from: "./client/assets/OFL.txt", to: "NotoSansSC-OFL.txt" }] },
      banner: { js: 'window.__ModuleLoader__.load({id:"@tack/research",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
      footer: { js: 'return module.exports;}});' },
      tools: { rspack: { target: "web", output: { chunkLoading: "jsonp" }, module: { rules: [{ test: /\.(svg|woff2)$/, type: "asset/inline" }] } } },
    },
  ],
  output: { distPath: { root: "./lib" }, cleanDistPath: true },
});
