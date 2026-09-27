/** Brand asset routes: configured files, or Tack's built-in marks. */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { ASSET_ROUTE, type ChromeConfig } from "./config.js";
import { PACKAGE_ROOT } from "./package-root.js";

const BUILT_IN = join(PACKAGE_ROOT, "assets");

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

export interface Asset {
  path: string;
  type: string;
}

const asset = (path: string): Asset => ({ path, type: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });

/**
 * Each brand slot with its fallback chain: a dark variant falls back to its
 * light one, a favicon to the logo, and an unconfigured logo to Tack's mark.
 */
export function brandAssets(chrome: ChromeConfig): Record<"logo" | "logoDark" | "favicon" | "faviconDark", Asset> {
  const { logo, logoDark, favicon, faviconDark } = chrome.brand;
  if (logo === null) {
    return {
      logo: asset(join(BUILT_IN, "tack-mark.svg")),
      logoDark: asset(logoDark ?? join(BUILT_IN, "tack-mark-dark.svg")),
      favicon: asset(favicon ?? join(BUILT_IN, "tack-mark.svg")),
      faviconDark: asset(faviconDark ?? favicon ?? join(BUILT_IN, "tack-mark-dark.svg")),
    };
  }
  return {
    logo: asset(logo),
    logoDark: asset(logoDark ?? logo),
    favicon: asset(favicon ?? logo),
    faviconDark: asset(faviconDark ?? favicon ?? logoDark ?? logo),
  };
}

/** Web app manifest; icon URLs resolve relative to the manifest's own URL. */
export function manifest(chrome: ChromeConfig): string {
  const assets = brandAssets(chrome);
  return JSON.stringify({
    name: chrome.product.name,
    short_name: chrome.product.shortName,
    start_url: "../",
    scope: "../",
    display: "standalone",
    icons: [{ src: "favicon", sizes: "any", type: assets.favicon.type, purpose: "any" }],
  });
}

export function assetHandler(chrome: ChromeConfig) {
  const assets = brandAssets(chrome);
  const files: Record<string, Asset> = {
    "/logo": assets.logo,
    "/logo-dark": assets.logoDark,
    "/favicon": assets.favicon,
    "/favicon-dark": assets.faviconDark,
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "").split("?")[0]!.slice(ASSET_ROUTE.length);
    let body: string | Buffer | undefined;
    let type = "";
    if (path === "/manifest.webmanifest") {
      body = manifest(chrome);
      type = "application/manifest+json";
    } else if (files[path] !== undefined && existsSync(files[path].path)) {
      body = readFileSync(files[path].path);
      type = files[path].type;
    }
    if (body === undefined || (req.method !== "GET" && req.method !== "HEAD")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
