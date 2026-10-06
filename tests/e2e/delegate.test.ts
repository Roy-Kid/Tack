/// <reference lib="dom" />
/**
 * Delegation in the browser: `tack web` with the Supervise preset as the
 * default, the Claude provider installed in the web profile, a scripted
 * supervisor model and a scripted Anthropic endpoint. The supervisor
 * delegates, Claude asks to run a command, the user allows it in the
 * approval panel, and the delegate card shows the outcome above Claude's
 * nested tool calls. Asserts what the user sees, and that the supervisor
 * could not edit or run commands itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { FAKE_ANTHROPIC_KEY, type FakeAnthropic, startFakeAnthropic } from "../fake-anthropic.js";
import { contentText, FAKE_KEY, FAKE_KEY_ENV, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { REPO_ROOT, spawnTack, tempHome } from "../helpers.js";
import { type ChromeServer, serveChrome } from "../web-chrome-server.js";

const PREINSTALLED = "/opt/pw-browsers/chromium";
const FINAL = "Claude wrote notes.txt; the command ran after you allowed it.";
const SUMMARY = "Wrote notes.txt and printed it.";

let home: string;
let model: FakeModel;
let claude: FakeAnthropic;
let server: ChromeServer;
let browser: Browser;

/** Every file under `dir` named `name`. */
function find(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : find(path, name);
    return entry === name ? [path] : [];
  });
}

beforeAll(async () => {
  home = tempHome();
  model = await startFakeModel();
  claude = await startFakeAnthropic();
  for (const args of fakeProviderCommands(model)) expect((await spawnTack(args, { home })).code).toBe(0);
  expect((await spawnTack(["auth", "set", FAKE_KEY_ENV], { home, input: FAKE_KEY })).code).toBe(0);
  expect((await spawnTack(["auth", "set", "ANTHROPIC_API_KEY"], { home, input: FAKE_ANTHROPIC_KEY })).code).toBe(0);
  const added = await spawnTack(["plugin", "add", join(REPO_ROOT, "packages", "agent-claude"), "--profile", "web"], { home });
  expect(added.code, added.stderr).toBe(0);
  const patch = join(home, "e2e-delegate.patch.yml");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    patch,
    [
      "- id: agent-preset-registry",
      "  config:",
      "    default: supervise",
      "- id: agent-claude",
      "  config:",
      `    baseUrl: ${JSON.stringify(claude.baseUrl)}`,
      "    maxTurns: 10",
      "",
    ].join("\n"),
  );
  server = await serveChrome(home, ["--patch", patch]);
  browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  await model?.close();
  await claude?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("delegation in the browser", () => {
  it("delegates to Claude, asks for approval in the browser, and shows the delegate card", async () => {
    model.script([
      { tool: "delegate", arguments: { agent: "claude", description: "Write notes", task: "Create notes.txt containing ok, then print it." } },
      { text: FINAL },
    ]);
    claude.script([
      { tool: "Bash", input: { command: "printf ok > notes.txt && cat notes.txt", description: "Write and print notes" } },
      {
        tool: "StructuredOutput",
        input: { status: "completed", summary: SUMMARY, filesChanged: ["notes.txt"], commands: [{ command: "printf ok > notes.txt && cat notes.txt", exitCode: 0 }] },
      },
      { text: "Done." },
    ]);
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.waitForSelector("[data-tack-brand-name]", { timeout: 60_000 });
      const composer = page.locator("[contenteditable=true]").first();
      await composer.click();
      await composer.pressSequentially("Write notes.txt");
      await page.keyboard.press("Enter");

      // Claude's command ask arrives in the browser's approval panel.
      await page.getByText(/Claude wants to run Bash/).first().waitFor({ timeout: 90_000 });
      await page.getByRole("button", { name: /allow once/i }).click();

      await page.getByText(FINAL).first().waitFor({ timeout: 90_000 });
      // A finished turn folds its tool calls; open it.
      await page.getByText(/^Completed in /).first().click();
      await page.getByText("Called tools").first().click();
      const card = page.locator("[data-tack-delegate-card]").first();
      await card.waitFor({ timeout: 30_000 });
      expect(await card.getAttribute("data-state")).toBe("completed");
      expect(await card.textContent()).toContain(SUMMARY);
      await card.locator(".tack-delegate-row").click();
      const body = card.locator("[data-tack-delegate-body]");
      await body.waitFor({ timeout: 10_000 });
      expect(await body.textContent()).toContain("notes.txt");
      expect(await body.textContent()).toContain("exit 0");
      // Claude's own tool call is nested under the delegation.
      await page.getByText("claude.Bash").first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(home, "delegate.png"), fullPage: true });

      // The supervisor delegated: it was offered `delegate` and no way to edit or run commands.
      const first = model.agentRequests()[0]!;
      expect(first.tools).toContain("delegate");
      expect(first.tools).toContain("read");
      for (const forbidden of ["bash", "write", "edit", "subagent", "workflow"]) expect(first.tools).not.toContain(forbidden);

      // The command really ran in the session's workspace.
      const notes = find(join(home, "workspaces"), "notes.txt");
      expect(notes).toHaveLength(1);
      expect(readFileSync(notes[0]!, "utf8")).toBe("ok");
    } finally {
      if (process.env.TACK_E2E_SCREENSHOTS) {
        try {
          await page.screenshot({ path: join(process.env.TACK_E2E_SCREENSHOTS, "delegate.png"), fullPage: true });
        } catch {
          // The page may already be gone.
        }
      }
      await page.close();
    }
  });

  it("runs a delegation in the background and reports it when the job finishes", async () => {
    const final = "The background delegation finished: all done.";
    const summary = "Read the notes in the background.";
    model.script([
      { tool: "delegate", arguments: { agent: "claude", description: "Background read", task: "Read notes.txt.", background: true } },
      { text: "Started; I'll report back." },
      // Woken by the job's completion notice.
      { tool: "job_output", arguments: { job_id: "delegate-1" } },
      { text: final },
    ]);
    claude.script([
      { tool: "Glob", input: { pattern: "*.txt" } },
      { tool: "StructuredOutput", input: { status: "completed", summary, filesChanged: [] } },
      { text: "Done." },
    ]);
    const before = model.agentRequests().length;
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.waitForSelector("[data-tack-brand-name]", { timeout: 60_000 });
      await page.getByText("New Session").first().click();
      const composer = page.locator("[contenteditable=true]").first();
      await composer.click();
      await composer.pressSequentially("Read the notes in the background");
      await page.keyboard.press("Enter");

      await page.getByText(final).first().waitFor({ timeout: 90_000 });
      const requests = model.agentRequests().slice(before);
      expect(requests).toHaveLength(4);
      const toolText = (index: number) =>
        requests[index]!.messages.filter((message) => message.role === "tool").map((message) => contentText(message.content)).join("\n");
      // The call returned at once with the job id.
      expect(toolText(1)).toContain("Started a background delegation to claude as job delegate-1");
      // The jobs service woke the supervisor with a completion notice.
      const woken = requests[2]!.messages.map((message) => contentText(message.content)).join("\n");
      expect(woken).toMatch(/delegate-1.*finished/s);
      // job_output handed over the rendered report.
      expect(toolText(3)).toContain(`Delegated to claude: completed.\n${summary}`);

      await page.getByText(/^Completed in /).first().click();
      await page.getByText("Called tools").first().click();
      const card = page.locator("[data-tack-delegate-card]").first();
      await card.waitFor({ timeout: 30_000 });
      expect(await card.getAttribute("data-state")).toBe("background");
      expect(await card.textContent()).toContain("job delegate-1");
    } finally {
      if (process.env.TACK_E2E_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.TACK_E2E_SCREENSHOTS, "delegate-background.png"), fullPage: true }).catch(() => {});
        writeFileSync(
          join(process.env.TACK_E2E_SCREENSHOTS, "delegate-background.json"),
          JSON.stringify({ supervisor: model.agentRequests().slice(before), claude: claude.agentRequests().length, server: server.output().slice(-4000) }, null, 1),
        );
      }
      await page.close();
    }
  });

  it("served without activation warnings", () => {
    expect(server.output()).not.toMatch(/did not activate/);
  });
});
