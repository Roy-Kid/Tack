/// <reference lib="dom" />
/**
 * Browser test of the web chrome: a real page load in Chromium with the
 * example integration. Asserts what a user of the integrator's product sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { REPO_ROOT, tempHome } from "../helpers.js";
import { type ChromeServer, serveChrome } from "../web-chrome-server.js";
import { RUNTIME_PRODUCT } from "../../packages/web-chrome/src/client/title.js";

const CHROME_FILE = join(REPO_ROOT, "examples", "web-chrome", "chrome.json");
const example = JSON.parse(readFileSync(CHROME_FILE, "utf8")) as {
  product: { name: string };
  splash: { wordmark: string; hint: string };
  welcome: { title: string };
};
/** Preinstalled browser when present (dev containers); otherwise Playwright's own download (CI). */
const PREINSTALLED = "/opt/pw-browsers/chromium";

let home: string;
let server: ChromeServer;
let browser: Browser;

beforeAll(async () => {
  home = tempHome();
  server = await serveChrome(home, ["--chrome", CHROME_FILE]);
  browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

async function open(colorScheme: "light" | "dark") {
  const page = await browser.newPage({ colorScheme });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __splash: string[] }).__splash = seen;
    new MutationObserver(() => {
      const card = document.querySelector("[data-dsh-boot]")?.firstElementChild;
      if (card) seen.push(`${card.children[0]?.textContent}|${card.children[2]?.textContent}`);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(server.url);
  await page.waitForSelector("[data-tack-brand-name]", { timeout: 60_000 });
  return page;
}

const cssColor = (value: string) => value.replace(/\s+/g, " ").trim();

describe("web chrome in the browser", () => {
  it("shows the integrator's product, theme, and splash in light mode", async () => {
    const page = await open("light");
    try {
      expect(await page.locator("[data-tack-brand-name]").first().textContent()).toBe(example.product.name);
      expect(await page.locator("[data-tack-brand-mark]").first().getAttribute("src")).toBe("tack-chrome/logo");
      await page.waitForFunction((name) => document.title.endsWith(name), example.product.name);
      expect(await page.title()).not.toContain(RUNTIME_PRODUCT);
      const splash = await page.evaluate(() => (window as unknown as { __splash: string[] }).__splash);
      expect(splash).toContain(`${example.splash.wordmark}|${example.splash.hint}`);
      expect(await page.locator("[data-tack-welcome]").count()).toBe(1);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(cssColor(background)).toBe("oklch(0.985 0.004 95)");
    } finally {
      await page.close();
    }
  });

  it("follows the theme's dark palette and dark logo", async () => {
    const page = await open("dark");
    try {
      expect(await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme"))).toBe(true);
      expect(await page.locator("[data-tack-brand-mark]").first().getAttribute("src")).toBe("tack-chrome/logo-dark");
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(cssColor(background)).toBe("oklch(0.17 0.015 265)");
    } finally {
      await page.close();
    }
  });
});
