/**
 * Delegation end to end: `tack run --profile supervise` (a scripted
 * supervisor model) delegates a failing-test fix to the Claude provider,
 * which runs the real Claude Agent SDK loop against a scripted Anthropic
 * endpoint. Asserts Tack's contract: the supervisor cannot edit or run
 * commands, the child's tool calls are mirrored into the session, its
 * permission ask goes through the host's approval service, the workspace is
 * actually changed, the supervisor receives a compact structured report, and
 * cancellation tears the child down.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
import { blockText, FAKE_ANTHROPIC_KEY, type FakeAnthropic, startFakeAnthropic, toolResults } from "../fake-anthropic.js";
import { contentText, FAKE_KEY, FAKE_KEY_ENV, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { BIN, REPO_ROOT, spawnTack, tempHome, testEnv } from "../helpers.js";

const PROFILE = "supervise";

let home: string;
let workdir: string;
let model: FakeModel;
let claude: FakeAnthropic;
let patchFile: string;
let approvalsLog: string;

const tack = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnTack(args, { home, cwd: workdir, ...options });

function writeRepo(): void {
  writeFileSync(join(workdir, "sum.js"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(join(workdir, "test.js"), 'import { sum } from "./sum.js";\nif (sum(2, 3) !== 5) { console.error("sum is wrong"); process.exit(1); }\nconsole.log("ok");\n');
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node test.js" } }));
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Text of a session log: JSONL, or JSONL written as one zstd frame per
 * append. A magic-number match inside compressed data is merged into the
 * next frame when it does not decode on its own.
 */
function readSessionLog(file: string): string {
  const bytes = readFileSync(file);
  if (!file.endsWith(".zstd")) return bytes.toString("utf8");
  const starts: number[] = [];
  for (let at = bytes.indexOf(ZSTD_MAGIC); at >= 0; at = bytes.indexOf(ZSTD_MAGIC, at + 1)) starts.push(at);
  let text = "";
  let from = starts[0] ?? 0;
  for (let index = 1; index <= starts.length; index += 1) {
    const to = starts[index] ?? bytes.length;
    try {
      text += zstdDecompressSync(bytes.subarray(from, to)).toString("utf8");
      from = to;
    } catch (error) {
      if (to === bytes.length) throw error;
    }
  }
  return text;
}

/** Every event of every session Tack saved under the home, in file order. */
function sessionEvents(): { type: string; [key: string]: unknown }[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.jsonl(\.zstd)?$/.test(entry)) files.push(path);
    }
  };
  walk(join(home, "sessions"));
  return files.flatMap((file) =>
    readSessionLog(file)
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
      .map((record) => ({ ...record.data, type: record.type })),
  );
}

beforeAll(async () => {
  home = tempHome();
  workdir = mkdtempSync(join(tmpdir(), "tack-delegate-work-"));
  writeRepo();
  model = await startFakeModel();
  claude = await startFakeAnthropic();
  for (const args of fakeProviderCommands(model)) expect((await tack(args)).code).toBe(0);
  expect((await tack(["auth", "set", FAKE_KEY_ENV], { input: FAKE_KEY })).code).toBe(0);
  expect((await tack(["auth", "set", "ANTHROPIC_API_KEY"], { input: FAKE_ANTHROPIC_KEY })).code).toBe(0);
  for (const plugin of [join(REPO_ROOT, "packages", "agent-claude"), join(REPO_ROOT, "tests", "fixtures", "approver")]) {
    const added = await tack(["plugin", "add", plugin, "--profile", PROFILE]);
    expect(added.code, added.stderr).toBe(0);
  }
  patchFile = join(home, "delegate-test.patch.yml");
  writeFileSync(patchFile, `- id: agent-claude\n  config:\n    baseUrl: ${JSON.stringify(claude.baseUrl)}\n    maxTurns: 12\n`);
  approvalsLog = join(home, "approvals.jsonl");
});

afterAll(async () => {
  await model?.close();
  await claude?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

const run = (task: string, env: NodeJS.ProcessEnv = {}) =>
  tack(["run", "--profile", PROFILE, "--patch", patchFile, task], { env: { TACK_TEST_APPROVALS_LOG: approvalsLog, ...env } });

const REPORT = {
  status: "completed",
  summary: "Fixed sum to add its arguments; npm test passes.",
  filesChanged: ["sum.js"],
  commands: [{ command: "npm test", exitCode: 0 }],
  tests: { command: "npm test", passed: true },
};

describe("tack run --profile supervise", () => {
  it("delegates a failing-test fix to Claude and reports the structured result", async () => {
    model.script([
      { tool: "delegate", arguments: { agent: "claude", description: "Fix failing test", task: "npm test fails; fix sum.js so it passes." } },
      { text: "Claude fixed sum.js and the tests pass." },
    ]);
    claude.script([
      { tool: "Read", input: { file_path: join(workdir, "sum.js") } },
      { tool: "Edit", input: { file_path: join(workdir, "sum.js"), old_string: "a - b", new_string: "a + b" } },
      { tool: "Bash", input: { command: "npm test", description: "Run the tests" } },
      { tool: "StructuredOutput", input: REPORT },
      { text: "Done." },
    ]);
    const supervisorBefore = model.agentRequests().length;
    const claudeBefore = claude.agentRequests().length;

    const result = await run("fix the failing test");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Claude fixed sum.js and the tests pass.");

    // The workspace really changed, and the tests really ran and passed.
    expect(readFileSync(join(workdir, "sum.js"), "utf8")).toContain("a + b");
    const claudeRequests = claude.agentRequests().slice(claudeBefore);
    expect(claudeRequests.every((request) => request.apiKey === FAKE_ANTHROPIC_KEY)).toBe(true);
    const bashResult = toolResults(claudeRequests.at(-1)!).find((block) => blockText(block.content).includes("ok"));
    expect(bashResult?.is_error ?? false).toBe(false);

    // The supervisor delegates; it cannot edit files or run commands itself.
    const supervisor = model.agentRequests().slice(supervisorBefore);
    expect(supervisor).toHaveLength(2);
    expect(supervisor[0]!.tools).toContain("delegate");
    for (const forbidden of ["bash", "write", "edit", "subagent", "workflow"]) expect(supervisor[0]!.tools).not.toContain(forbidden);
    expect(supervisor[0]!.tools).toContain("read");

    // It receives the compact report, never Claude's transcript.
    const reported = contentText(supervisor[1]!.messages.find((message) => message.role === "tool")?.content);
    expect(reported).toContain("Delegated to claude: completed.");
    expect(reported).toContain(REPORT.summary);
    expect(reported).toContain("Files changed: sum.js");
    expect(reported).toContain("Tests: `npm test` passed");
    expect(reported).not.toContain("a - b");

    // The Bash ask went through the host's approval service.
    const approvals = readFileSync(approvalsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { toolName: string; outcome: string });
    expect(approvals).toEqual([expect.objectContaining({ toolName: "claude.Bash", outcome: "allowed-once" })]);

    // Claude's tool calls are mirrored into the session, nested under the delegate call.
    const events = sessionEvents();
    const starts = events.filter((event) => event.type === "tool/ptc-dispatch-start");
    expect(starts.map((event) => event.name)).toEqual(["claude.Read", "claude.Edit", "claude.Bash"]);
    const ends = events.filter((event) => event.type === "tool/ptc-dispatch");
    expect(ends).toHaveLength(3);
    expect(ends.every((event) => event.isError === false)).toBe(true);
    expect(new Set(starts.map((event) => event.parentCallId)).size).toBe(1);
    expect(events.some((event) => event.type === "approval/asked")).toBe(true);
    expect(events.some((event) => event.type === "approval/decided")).toBe(true);
  });

  it("denies an ask nobody can answer and tells Claude why", async () => {
    writeRepo();
    model.script([
      { tool: "delegate", arguments: { agent: "claude", description: "Run the tests", task: "Run npm test and report." } },
      { text: "Claude could not run the tests." },
    ]);
    claude.script([
      { tool: "Bash", input: { command: "npm test", description: "Run the tests" } },
      { tool: "StructuredOutput", input: { status: "failed", summary: "Running commands was not approved.", filesChanged: [] } },
      { text: "Not approved." },
    ]);
    const before = claude.agentRequests().length;
    // The answer a headless run gets when no one can approve.
    const result = await run("run the tests", { TACK_TEST_APPROVAL: "unavailable" });
    expect(result.code, result.stderr).toBe(0);
    const results = claude.agentRequests().slice(before).flatMap(toolResults);
    const denied = results.find((block) => blockText(block.content).includes("Not approved"));
    expect(denied?.is_error).toBe(true);
    expect(readFileSync(approvalsLog, "utf8")).toContain('"outcome":"unavailable"');
    const reported = contentText(model.agentRequests().at(-1)!.messages.find((message) => message.role === "tool")?.content);
    expect(reported).toContain("Delegated to claude: failed.");
  });

  it("tears Claude down when the run is interrupted", async () => {
    const held = await startFakeAnthropic([{ hold: true }]);
    const heldPatch = join(home, "held.patch.yml");
    writeFileSync(heldPatch, `- id: agent-claude\n  config:\n    baseUrl: ${JSON.stringify(held.baseUrl)}\n`);
    model.script([{ tool: "delegate", arguments: { agent: "claude", description: "Long task", task: "Take your time." } }, { text: "unreachable" }]);
    const within = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref())]);
    const child = spawn(process.execPath, [BIN, "run", "--profile", PROFILE, "--patch", heldPatch, "long task"], {
      env: testEnv(home),
      cwd: workdir,
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      expect(await within(held.held(), 60_000)).not.toBe("timeout");
      child.kill("SIGINT");
      expect(await within(exited, 15_000)).not.toBe("timeout");
      // Claude's in-flight request ends with its process.
      expect(await within(held.heldClosed(), 5_000)).not.toBe("timeout");
    } finally {
      child.kill("SIGKILL");
      await held.close();
    }
  });
});

describe("tack doctor --profile supervise", () => {
  it("lists the delegate tool once a provider is installed", async () => {
    const result = await tack(["doctor", "--profile", PROFILE, "--tools"]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toContain("delegate");
    expect(existsSync(join(home, "profiles", PROFILE))).toBe(true);
  });
});
