/**
 * Complete agent turns through `tack run`, against a scripted local model
 * reached as an ordinary custom provider. Asserts Tack's contract: the answer
 * on stdout, exit codes, what reaches the model (persona, tool results), and
 * that tools and plugins run. Never the runtime's own wording.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, FAKE_KEY, FAKE_KEY_ENV, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { REPO_ROOT, spawnTack, tempHome } from "../helpers.js";

let home: string;
let workdir: string;
let model: FakeModel;

const tack = (args: string[], input?: string) => spawnTack(args, { home, cwd: workdir, ...(input !== undefined && { input }) });

beforeAll(async () => {
  home = tempHome();
  workdir = mkdtempSync(join(tmpdir(), "tack-agent-work-"));
  model = await startFakeModel();
  for (const args of fakeProviderCommands(model)) expect((await tack(args)).code).toBe(0);
  expect((await tack(["auth", "set", FAKE_KEY_ENV], FAKE_KEY)).code).toBe(0);
});

afterAll(async () => {
  await model.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

/** Run one task with a fresh script; returns the result and the agent requests it made. */
async function turn(steps: Parameters<FakeModel["script"]>[0], args: string[], input?: string) {
  model.script(steps);
  const before = model.agentRequests().length;
  const result = await tack(["run", ...args], input);
  return { result, requests: model.agentRequests().slice(before) };
}

describe("tack run against a model", () => {
  it("answers a task: the model's text is stdout, exit 0", async () => {
    const { result, requests } = await turn([{ text: "Hello from the scripted model." }], ["say hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Hello from the scripted model.");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(requests[0]!.model).toBe("fake-1");
  });

  it("introduces the agent as Tack and never as the runtime", async () => {
    const { requests } = await turn([{ text: "ok" }], ["who are you"]);
    const system = requests[0]!.messages.filter((message) => message.role === "system").map((message) => contentText(message.content)).join("\n");
    expect(system.trimStart().startsWith("You are Tack")).toBe(true);
    expect(system).not.toMatch(/DeepSeek Harness/);
  });

  it("runs a tool and hands its result back to the model", async () => {
    const secret = `tack-tool-check-${Date.now()}`;
    writeFileSync(join(workdir, "notes.txt"), `${secret}\n`);
    const { result, requests } = await turn(
      [{ tool: "read", arguments: { file_path: join(workdir, "notes.txt") } }, { text: "The file holds the check value." }],
      ["read notes.txt"],
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("The file holds the check value.");
    expect(requests).toHaveLength(2);
    const toolResult = requests[1]!.messages.find((message) => message.role === "tool");
    expect(contentText(toolResult?.content)).toContain(secret);
  });

  it("reads the task from stdin with -", async () => {
    const { result, requests } = await turn([{ text: "From stdin." }], ["-"], "task from a pipe");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("From stdin.");
    const user = requests[0]!.messages.filter((message) => message.role === "user").map((message) => contentText(message.content));
    expect(user.some((text) => text.includes("task from a pipe"))).toBe(true);
  });

  it("uses --model for one run", async () => {
    const { result, requests } = await turn([{ text: "One-run model." }], ["--model", "fake/fake-1", "hi"]);
    expect(result.code).toBe(0);
    expect(requests[0]!.model).toBe("fake-1");
  });

  it("calls a plugin's tool", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "tack-agent-pack-"));
    try {
      execFileSync("npm", ["pack", join(REPO_ROOT, "examples", "plugin-echo"), "--pack-destination", packDir, "--silent"], { stdio: "ignore" });
      const tarball = join(packDir, readdirSync(packDir).find((entry) => entry.endsWith(".tgz"))!);
      expect((await tack(["plugin", "add", tarball])).code).toBe(0);
      const { result, requests } = await turn([{ tool: "tack_echo", arguments: { text: "echoed by the plugin" } }, { text: "done" }], ["echo something"]);
      expect(result.code).toBe(0);
      expect(requests[0]!.tools).toContain("tack_echo");
      expect(contentText(requests[1]!.messages.find((message) => message.role === "tool")?.content)).toContain("echoed by the plugin");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

describe("tack run without a key", () => {
  it("exits 1 and names Tack's command for setting it", async () => {
    const bare = tempHome();
    try {
      const result = await spawnTack(["run", "hi"], { home: bare, cwd: workdir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("tack auth set DEEPSEEK_API_KEY");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
