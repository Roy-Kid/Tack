import { describe, expect, it } from "@rstest/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeSource, HOME_CHROME_FILE } from "../../packages/tack/src/chrome.js";
import { browserChrome, ChromeConfigError, DEFAULT_CHROME, resolveChrome } from "../../packages/web-chrome/src/host/config.js";
import { loadChromeFile } from "../../packages/web-chrome/src/host/file.js";

const scratch = () => mkdtempSync(join(tmpdir(), "tack-chrome-"));

describe("resolveChrome", () => {
  it("gives Tack's defaults when nothing is configured", () => {
    for (const input of [undefined, null, {}]) {
      const chrome = resolveChrome(input);
      expect(chrome).toEqual(DEFAULT_CHROME);
      expect(chrome.product.name).toBe("Tack");
      expect(chrome.brand.logo).toBeNull();
      expect(chrome.welcome.enabled).toBe(false);
      expect(chrome.version.show).toBe(true);
      expect(chrome.theme.appearance).toBe("system");
    }
  });

  it("fills omitted keys from the defaults and never mutates them", () => {
    const chrome = resolveChrome({ product: { name: "Acme" }, theme: { appearance: "dark" } });
    expect(chrome.product).toEqual({ ...DEFAULT_CHROME.product, name: "Acme" });
    expect(chrome.theme.appearance).toBe("dark");
    expect(chrome.splash).toEqual(DEFAULT_CHROME.splash);
    chrome.product.name = "changed";
    expect(DEFAULT_CHROME.product.name).toBe("Tack");
  });

  it("accepts a $schema key for editor tooling", () => {
    expect(resolveChrome({ $schema: "./chrome.schema.json" }).product.name).toBe("Tack");
  });

  it("rejects unknown sections and keys, naming them", () => {
    expect(() => resolveChrome({ colours: {} })).toThrow(/unknown setting "colours"/);
    expect(() => resolveChrome({ product: { title: "x" } })).toThrow(/unknown setting "product.title"/);
    expect(() => resolveChrome({ product: { title: "x" } })).toThrow(ChromeConfigError);
  });

  it("rejects values of the wrong type, naming the key", () => {
    expect(() => resolveChrome({ theme: { appearance: "blue" } })).toThrow(/theme.appearance/);
    expect(() => resolveChrome({ welcome: { enabled: "yes" } })).toThrow(/welcome.enabled/);
    expect(() => resolveChrome({ brand: { logo: 3 } })).toThrow(/brand.logo/);
    expect(() => resolveChrome({ product: "Acme" })).toThrow(/product must be an object/);
    expect(() => resolveChrome([])).toThrow(ChromeConfigError);
    expect(() => resolveChrome({ product: { name: "  " } })).toThrow(/product.name/);
  });
});

describe("loadChromeFile", () => {
  it("resolves asset paths against the file and inlines the stylesheets", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, "brand"));
      writeFileSync(join(dir, "brand", "logo.png"), "png");
      writeFileSync(join(dir, "tokens.css"), ":root { --background: red; }");
      writeFileSync(join(dir, "extra.css"), ".x { color: red; }");
      writeFileSync(
        join(dir, "chrome.json"),
        JSON.stringify({ brand: { logo: "brand/logo.png" }, theme: { css: "tokens.css", customCss: "extra.css" } }),
      );
      const chrome = loadChromeFile(join(dir, "chrome.json"));
      expect(chrome.brand.logo).toBe(join(dir, "brand", "logo.png"));
      expect(chrome.brand.favicon).toBeNull();
      expect(chrome.theme.css).toBe(":root { --background: red; }");
      expect(chrome.theme.customCss).toBe(".x { color: red; }");
      expect(chrome.theme.source).toBe("tokens.css");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing file, invalid JSON, and a missing referenced file", () => {
    const dir = scratch();
    try {
      expect(() => loadChromeFile(join(dir, "none.json"))).toThrow(/does not exist/);
      writeFileSync(join(dir, "bad.json"), "{ product: ");
      expect(() => loadChromeFile(join(dir, "bad.json"))).toThrow(/not valid JSON/);
      writeFileSync(join(dir, "ref.json"), JSON.stringify({ brand: { logo: "gone.svg" } }));
      expect(() => loadChromeFile(join(dir, "ref.json"))).toThrow(/brand.logo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chrome settings source", () => {
  it("prefers the flag, then the home file, then none", () => {
    const home = scratch();
    try {
      expect(chromeSource(home, undefined)).toBeUndefined();
      writeFileSync(join(home, HOME_CHROME_FILE), "{}");
      expect(chromeSource(home, undefined)).toBe(join(home, HOME_CHROME_FILE));
      expect(chromeSource(home, "other.json")).toBe("other.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("browserChrome", () => {
  it("publishes no file paths or stylesheet text to the page", () => {
    const chrome = resolveChrome({
      product: { name: "Acme" },
      brand: { logo: "/secret/dir/logo.svg" },
      theme: { css: ":root{--background:red}" },
    });
    const payload = JSON.stringify(browserChrome(chrome, "Acme 1.0"));
    expect(payload).not.toContain("/secret/dir");
    expect(payload).not.toContain("--background");
    expect(browserChrome(chrome, "v").splash.wordmark).toBe("Acme");
    expect(browserChrome(chrome, "v").version.label).toBe("v");
  });
});
