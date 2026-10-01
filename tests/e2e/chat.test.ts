/// <reference lib="dom" />
/**
 * A complete conversation in the browser: `tack web` on a scripted local
 * model, a message typed into the composer, the reply rendered, and the
 * session still there after a reload. Asserts what the user sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { FAKE_KEY, FAKE_KEY_ENV, type FakeModel, fakeProviderCommands, HOUSEKEEPING_REPLY, startFakeModel } from "../fake-model.js";
import { spawnTack, tempHome } from "../helpers.js";
import { type ChromeServer, serveChrome } from "../web-chrome-server.js";

const PREINSTALLED = "/opt/pw-browsers/chromium";
const REPLY = "Hello from the scripted model, in the browser.";

let home: string;
let model: FakeModel;
let server: ChromeServer;
let browser: Browser;

beforeAll(async () => {
  home = tempHome();
  model = await startFakeModel([{ text: REPLY }]);
  for (const args of fakeProviderCommands(model)) expect((await spawnTack(args, { home })).code).toBe(0);
  expect((await spawnTack(["auth", "set", FAKE_KEY_ENV], { home, input: FAKE_KEY })).code).toBe(0);
  server = await serveChrome(home, []);
  browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  await model?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("chat in the browser", () => {
  it("sends a message, shows the reply, and keeps the session after a reload", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.waitForSelector("[data-tack-brand-name]", { timeout: 60_000 });
      const composer = page.locator("[contenteditable=true]").first();
      await composer.click();
      await composer.pressSequentially("Say hello");
      await page.keyboard.press("Enter");
      await page.getByText(REPLY).first().waitFor({ timeout: 60_000 });
      expect(model.agentRequests()).toHaveLength(1);

      await page.goto(server.base);
      await page.waitForSelector("[data-tack-brand-name]", { timeout: 60_000 });
      await page.getByText(HOUSEKEEPING_REPLY).first().waitFor({ timeout: 30_000 });
      await page.getByText(HOUSEKEEPING_REPLY).first().click();
      await page.getByText(REPLY).first().waitFor({ timeout: 30_000 });
    } finally {
      await page.close();
    }
  });

  it("creates the default workspace under Tack's home", () => {
    expect(existsSync(join(home, "workspaces"))).toBe(true);
  });

  it("served without activation warnings", () => {
    expect(server.output()).not.toMatch(/did not activate/);
  });
});
