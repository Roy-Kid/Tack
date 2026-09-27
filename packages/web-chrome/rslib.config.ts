import { defineConfig } from "@rslib/core";

/** The package name: the browser loader keys the bundle by it. */
const ID = "@tack/web-chrome";

/** Modules the runtime's browser shell seeds; everything else is bundled. */
export const SEED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];

export default defineConfig({
  lib: [
    // Host half: Node ESM, file for file.
    {
      format: "esm",
      syntax: "es2024",
      bundle: false,
      dts: true,
      source: { tsconfigPath: "./tsconfig.host.json", entry: { index: ["./src/host/**/*.ts"] } },
      output: { target: "node", distPath: { root: "./lib" }, externals: [/^@deepseek-ai\//] },
    },
    // Browser half: one classic script registered with the runtime's module loader.
    {
      format: "cjs",
      syntax: "es2022",
      bundle: true,
      dts: false,
      autoExtension: false,
      shims: { cjs: { "import.meta.url": false, "import.meta.dirname": false, "import.meta.filename": false } },
      source: { entry: { client: "./src/client/index.tsx" } },
      output: {
        target: "web",
        distPath: { root: "./lib" },
        filename: { js: "[name].js" },
        autoExternal: false,
        externals: Object.fromEntries(SEED_MODULES.map((name) => [name, `commonjs ${name}`])),
        minify: false,
      },
      banner: {
        js: `window.__ModuleLoader__.load({id:${JSON.stringify(ID)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
      },
      footer: { js: "return module.exports;}});" },
      tools: {
        swc: { jsc: { transform: { react: { runtime: "automatic" } } } },
        rspack: { output: { asyncChunks: false } },
      },
    },
  ],
});
