/** The page shell Tack's web chrome owns: index rewrites, splash, title, brand assets, and the browser bundle. */
import { describe, expect, it } from "@rstest/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { productTitle, RUNTIME_PRODUCT, RUNTIME_SEPARATOR } from "../../packages/web-chrome/src/client/title.js";
import { brandAssets, manifest } from "../../packages/web-chrome/src/host/assets.js";
import { resolveChrome } from "../../packages/web-chrome/src/host/config.js";
import { rewriteIndex, splashScript } from "../../packages/web-chrome/src/host/index-rewrite.js";
import { SEED_MODULES } from "../../packages/web-chrome/rslib.config.js";
import { REPO_ROOT, readJson } from "../helpers.js";

const PACKAGE_DIR = join(REPO_ROOT, "packages", "web-chrome");

const RUNTIME_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>Runtime Product</title>
    <script type="module" src="./assets/index.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("rewriteIndex", () => {
  it("owns the title, icons, and manifest", () => {
    const html = rewriteIndex(RUNTIME_INDEX, resolveChrome({ product: { name: "Acme & <Co>" } }));
    expect(html).toContain("<title>Acme &amp; &lt;Co&gt;</title>");
    const hrefs = [...html.matchAll(/<link\b[^>]*rel="(icon|manifest)"[^>]*href="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(hrefs.sort()).toEqual(["icon tack-chrome/favicon", "icon tack-chrome/favicon-dark", "manifest tack-chrome/manifest.webmanifest"]);
    expect(html).toContain('<script type="module" src="./assets/index.js"></script>');
  });

  it("types icon links by the configured file", () => {
    const html = rewriteIndex(RUNTIME_INDEX, resolveChrome({ brand: { logo: "/x/logo.png" } }));
    expect(html).toMatch(/type="image\/png" href="tack-chrome\/favicon"/);
  });
});

describe("splashScript", () => {
  it("is valid script that cannot close its own tag", () => {
    const text = splashScript("ACME", "</script><b>");
    expect(() => new Function(text)).not.toThrow();
    expect(text).not.toContain("</script>");
  });
});

describe("productTitle", () => {
  it("puts the product name in place of the runtime's, keeping the session", () => {
    expect(productTitle(RUNTIME_PRODUCT, "Acme", " · ")).toBe("Acme");
    expect(productTitle("", "Acme", " · ")).toBe("Acme");
    expect(productTitle(`My session${RUNTIME_SEPARATOR}${RUNTIME_PRODUCT}`, "Acme", " · ")).toBe("My session · Acme");
    expect(productTitle("My session · Acme", "Acme", " · ")).toBe("My session · Acme");
  });
});

describe("brand assets", () => {
  it("falls back to Tack's built-in marks", () => {
    const assets = brandAssets(resolveChrome({}));
    for (const asset of Object.values(assets)) {
      expect(existsSync(asset.path)).toBe(true);
      expect(asset.type).toBe("image/svg+xml");
    }
    expect(assets.logoDark.path).not.toBe(assets.logo.path);
  });

  it("derives every variant from a single logo", () => {
    const assets = brandAssets(resolveChrome({ brand: { logo: "/x/logo.png" } }));
    expect(Object.values(assets).map((asset) => asset.path)).toEqual(["/x/logo.png", "/x/logo.png", "/x/logo.png", "/x/logo.png"]);
  });

  it("prefers a configured favicon for both schemes when no dark favicon is set", () => {
    const assets = brandAssets(resolveChrome({ brand: { logo: "/x/l.svg", logoDark: "/x/ld.svg", favicon: "/x/f.ico" } }));
    expect(assets.favicon.path).toBe("/x/f.ico");
    expect(assets.faviconDark.path).toBe("/x/f.ico");
    expect(assets.favicon.type).toBe("image/x-icon");
  });

  it("names the manifest after the product", () => {
    const parsed = JSON.parse(manifest(resolveChrome({ product: { name: "Acme Assistant", shortName: "Acme" } }))) as Record<string, unknown>;
    expect(parsed.name).toBe("Acme Assistant");
    expect(parsed.short_name).toBe("Acme");
  });
});

describe("browser bundle", () => {
  const manifestJson = readJson<{ name: string; exports: Record<string, string>; dsh: { client: { platform: string } } }>(join(PACKAGE_DIR, "package.json"));
  const bundle = readFileSync(join(PACKAGE_DIR, manifestJson.exports["./client"]!), "utf8");

  it("is declared as the package's browser face", () => {
    expect(manifestJson.dsh.client.platform).toBe("web");
  });

  it("registers itself with the page's module loader under the package name", () => {
    expect(bundle.startsWith(`window.__ModuleLoader__.load({id:${JSON.stringify(manifestJson.name)},`)).toBe(true);
  });

  it("requires nothing beyond the page's seed modules", () => {
    const required = new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!));
    expect([...required].filter((name) => !SEED_MODULES.includes(name))).toEqual([]);
  });

  it("exports a plugin face", () => {
    let registration: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined;
    runInNewContext(bundle, { window: { __ModuleLoader__: { load: (r: typeof registration) => (registration = r) } } });
    const exports = registration!.factory(() => new Proxy({}, { get: () => () => null }));
    expect(typeof exports.apply).toBe("function");
    expect(exports.inject).toEqual(["slots"]);
  });
});
