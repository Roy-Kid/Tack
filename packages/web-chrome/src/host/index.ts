/**
 * Host half of Tack's web chrome. Resolves the chrome settings (row config),
 * provides them as the `tackChrome` service, and owns the page shell: the
 * compiled theme stylesheet, the browser settings global, the splash text,
 * the title, favicon, and manifest, and the brand asset routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import { assetHandler } from "./assets.js";
import { ASSET_ROUTE, browserChrome, resolveChrome } from "./config.js";
import { rewriteIndex, splashScript } from "./index-rewrite.js";
import { packageVersion } from "./package-root.js";
import { compileTheme } from "./theme.js";

export const name = "tack-web-chrome";

/** Global the browser half reads before its first render. */
export const BROWSER_GLOBAL = "__TACK_CHROME__";

type IndexInjection =
  | { kind: "global"; name: string; value: unknown }
  | { kind: "style"; text: string }
  | { kind: "script"; placement: "head" | "body"; text: string };

interface WebServer {
  tapIndex(transform: (html: string) => string): () => void;
  register(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void;
}

interface HostContext {
  provide(name: string, value: unknown): void;
  on(event: "webserver/index-inject", listener: (table: IndexInjection[]) => void): () => void;
  effect(execute: () => () => void, label?: string): void;
  inject(deps: string[], callback: (ctx: HostContext & { webServer: WebServer }) => void): void;
}

export function apply(ctx: HostContext, config: unknown): void {
  const chrome = resolveChrome(config);
  ctx.provide("tackChrome", chrome);
  const theme = compileTheme(chrome.theme.css ?? undefined, chrome.theme.customCss ?? undefined, chrome.theme.source);
  const browser = browserChrome(chrome, `${chrome.product.name} ${packageVersion()} · runtime ${getDshRuntimeVersion()}`);
  ctx.on("webserver/index-inject", (table) => {
    table.push(
      { kind: "global", name: BROWSER_GLOBAL, value: browser },
      { kind: "style", text: theme.css },
      { kind: "script", placement: "head", text: splashScript(browser.splash.wordmark, browser.splash.hint) },
    );
  });
  ctx.inject(["webServer"], (web) => {
    web.effect(() => web.webServer.tapIndex((html) => rewriteIndex(html, chrome)), "tack-web-chrome: index");
    web.effect(() => web.webServer.register({ kind: "prefix", path: ASSET_ROUTE, handler: assetHandler(chrome) }), "tack-web-chrome: assets");
  });
}
