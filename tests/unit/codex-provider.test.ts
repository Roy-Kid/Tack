/**
 * `@tack/codex` against a scripted app-server: the protocol round trip, what a
 * failure says, unattended answers to server requests, and structured output.
 */
import { describe, expect, it } from "@rstest/core";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTarget } from "../../packages/codex/src/record.js";
import { settleTurn } from "../../packages/codex/src/run.js";
import { CodexAppServer } from "../../packages/codex/src/wire.js";

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };

/** A scripted app-server: `on(method)` answers a client request; `send` pushes a frame. */
function fakeServer() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const handlers = new Map<string, (params: Record<string, unknown>, id: number | string) => void>();
  const replies = new Map<number | string, (result: unknown) => void>();
  const received: Message[] = [];
  let nextId = 1000;
  const send = (message: object): void => {
    toClient.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  createInterface({ input: fromClient }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    received.push(message);
    if (message.method !== undefined && message.id !== undefined) handlers.get(message.method)?.(message.params ?? {}, message.id);
    else if (message.method === undefined && message.id !== undefined) replies.get(message.id)?.(message.result);
  });
  return {
    stdout: toClient,
    stdin: fromClient,
    received,
    on(method: string, handler: (params: Record<string, unknown>, id: number | string) => void) {
      handlers.set(method, handler);
    },
    reply(id: number | string, result: unknown) {
      send({ id, result });
    },
    fail(id: number | string, message: string) {
      send({ id, error: { code: -32600, message } });
    },
    notify(method: string, params: object) {
      send({ method, params });
    },
    /** Send a server request and resolve with the client's answer. */
    ask(method: string, params: object): Promise<unknown> {
      const id = nextId++;
      const answered = new Promise<unknown>((resolve) => replies.set(id, resolve));
      send({ id, method, params });
      return answered;
    },
  };
}

const THREAD = "thr-1";
const TURN = "turn-1";
const signal = () => new AbortController().signal;

function handshake(server: ReturnType<typeof fakeServer>, model = "gpt-6-sol"): void {
  server.on("initialize", (_params, id) => server.reply(id, { userAgent: "codex/0.166.0", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" }));
  server.on("thread/start", (_params, id) => server.reply(id, { thread: { id: THREAD, ephemeral: true }, model }));
}

const agentMessage = (text: string, phase: string | null) => ({
  threadId: THREAD,
  turnId: TURN,
  completedAtMs: 0,
  item: { type: "agentMessage", id: `m-${text}`, text, phase, memoryCitation: null, delivery: null, questions: null },
});
const usage = { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 } };
const completed = (status: string, error: object | null = null) => ({ threadId: THREAD, turn: { id: TURN, status, error, items: [] } });

async function connect(server: ReturnType<typeof fakeServer>, mode: "never" | "approve-for-me" = "never") {
  const client = new CodexAppServer(server.stdout, server.stdin, mode);
  await client.initialize("0.1.0", signal());
  await client.startThread({ cwd: "/work", ephemeral: true, permissionMode: mode }, signal());
  return client;
}

describe("@tack/codex wire", () => {
  it("runs one ephemeral thread and returns the final answer and token usage", async () => {
    const server = fakeServer();
    handshake(server);
    server.on("turn/start", (_params, id) => {
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
      server.notify("item/completed", agentMessage("thinking aloud", "commentary"));
      server.notify("item/completed", agentMessage("The plan is ready.", "final_answer"));
      server.notify("thread/tokenUsage/updated", { threadId: THREAD, turnId: TURN, tokenUsage: { ...usage, last: usage.total, modelContextWindow: null } });
      server.notify("turn/completed", completed("completed"));
    });
    const client = await connect(server, "approve-for-me");
    const outcome = await client.runTurn(["plan it"], {}, signal());
    expect(outcome).toMatchObject({ status: "completed", answer: "The plan is ready." });
    expect(outcome.usage?.total.outputTokens).toBe(10);
    expect(client.model).toBe("gpt-6-sol");
    const start = server.received.find((message) => message.method === "thread/start");
    expect(start?.params).toMatchObject({ cwd: "/work", ephemeral: true, approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(settleTurn(outcome, client.model, client.declinedRequests(), false)).toEqual({
      output: [{ type: "text", text: "The plan is ready." }],
      stopReason: "completed",
    });
  });

  it("keeps notifications that arrive before turn/start returns", async () => {
    const server = fakeServer();
    handshake(server);
    server.on("turn/start", (_params, id) => {
      server.notify("item/completed", agentMessage("early answer", "final_answer"));
      server.notify("turn/completed", completed("completed"));
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
    });
    const client = await connect(server);
    expect((await client.runTurn(["go"], {}, signal())).answer).toBe("early answer");
  });

  it("reports Codex's own reason when the thread cannot start", async () => {
    const server = fakeServer();
    server.on("initialize", (_params, id) => server.reply(id, { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" }));
    server.on("thread/start", (_params, id) => server.fail(id, "The 'gpt-9' model is not supported when using Codex with a ChatGPT account."));
    const client = new CodexAppServer(server.stdout, server.stdin, "never");
    await client.initialize("0.1.0", signal());
    await expect(client.startThread({ cwd: "/work", ephemeral: true, model: "gpt-9", permissionMode: "never" }, signal())).rejects.toThrow("model is not supported");
  });

  it("a failed turn's diagnostic carries the message, the error code and the model", async () => {
    const server = fakeServer();
    handshake(server);
    server.on("turn/start", (_params, id) => {
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
      server.notify("turn/completed", completed("failed", { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null }));
    });
    const client = await connect(server);
    const settled = settleTurn(await client.runTurn(["go"], {}, signal()), client.model, [], false);
    expect(settled.stopReason).toBe("error");
    expect(settled.diagnostic).toBe("Codex: Usage limit reached (code: usageLimitExceeded; model: gpt-6-sol)");
  });

  it("declines requests that need a human and says so", async () => {
    const server = fakeServer();
    handshake(server);
    let answer: unknown;
    server.on("turn/start", (_params, id) => {
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
      void server
        .ask("item/commandExecution/requestApproval", { threadId: THREAD, turnId: TURN, itemId: "i1", command: "rm -rf build", cwd: "/work" })
        .then((reply) => {
          answer = reply;
          server.notify("item/completed", agentMessage("Could not clean the build.", "final_answer"));
          server.notify("turn/completed", completed("completed"));
        });
    });
    const client = await connect(server);
    const settled = settleTurn(await client.runTurn(["clean"], {}, signal()), client.model, client.declinedRequests(), false);
    expect(answer).toEqual({ decision: "decline" });
    expect(settled.stopReason).toBe("completed");
    expect(settled.diagnostic).toContain("command: rm -rf build");
  });

  it("passes an output schema and returns the parsed object", async () => {
    const server = fakeServer();
    handshake(server);
    server.on("turn/start", (params, id) => {
      expect(params.outputSchema).toEqual({ type: "object" });
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
      server.notify("item/completed", agentMessage('{"steps":3}', "final_answer"));
      server.notify("turn/completed", completed("completed"));
    });
    const client = await connect(server);
    const outcome = await client.runTurn(["plan"], { outputSchema: { type: "object" } }, signal());
    expect(settleTurn(outcome, client.model, [], true)).toMatchObject({ structured: { steps: 3 }, stopReason: "completed" });
    expect(settleTurn({ status: "completed", answer: "not json" }, undefined, [], true).stopReason).toBe("error");
  });

  it("logs every command Codex ran and every file it changed", async () => {
    const server = fakeServer();
    handshake(server);
    server.on("turn/start", (_params, id) => {
      server.reply(id, { turn: { id: TURN, status: "inProgress", error: null, items: [] } });
      server.notify("item/completed", {
        threadId: THREAD,
        turnId: TURN,
        completedAtMs: 0,
        item: { type: "commandExecution", id: "c1", command: "python -c 'import rdkit'", cwd: "/work", status: "failed", exitCode: 1, commandActions: [], aggregatedOutput: null, durationMs: 5, pluginId: null, scriptPath: null, processId: null, source: "agent" },
      });
      server.notify("item/completed", {
        threadId: THREAD,
        turnId: TURN,
        completedAtMs: 0,
        item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/work/plan.md", kind: { type: "add" }, diff: "" }] },
      });
      server.notify("item/completed", agentMessage("done", "final_answer"));
      server.notify("turn/completed", completed("completed"));
    });
    const client = await connect(server);
    await client.runTurn(["go"], {}, signal());
    expect(client.activityLog()).toEqual([
      { kind: "command", command: "python -c 'import rdkit'", cwd: "/work", status: "failed", exitCode: 1 },
      { kind: "file", path: "/work/plan.md", change: "add", status: "completed" },
    ]);
  });
});

describe("@tack/codex hook trust", () => {
  it("names enabled hooks Codex will skip as untrusted", async () => {
    const server = fakeServer();
    handshake(server);
    const hook = (key: string, trustStatus: string, enabled = true) => ({ key, trustStatus, enabled, eventName: "preToolUse", handlerType: "command", command: "x" });
    server.on("hooks/list", (params, id) => {
      expect(params.threadId).toBe(THREAD);
      server.reply(id, {
        data: [
          {
            cwd: "/work",
            warnings: [],
            errors: [],
            hooks: [hook("molcrafts@molcrafts:hooks/codex.json:pre_tool_use:0:0", "untrusted"), hook("a:stop:0:0", "trusted"), hook("b:stop:0:0", "modified"), hook("c:stop:0:0", "untrusted", false)],
          },
        ],
      });
    });
    const client = await connect(server);
    expect(await client.untrustedHooks(signal())).toEqual(["molcrafts@molcrafts:hooks/codex.json:pre_tool_use:0:0 (untrusted)", "b:stop:0:0 (modified)"]);
  });
});

describe("@tack/codex record location", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-record-"));
  const workspace = join(root, "lab");
  const run = join(workspace, "projects", "p", "experiments", "e");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(workspace, "index.md"), "---\ntype: workspace.root\nname: Lab\n---\n");
  writeFileSync(join(workspace, "projects", "p", "index.md"), "---\ntype: workspace.project\n---\n");

  it("follows the molab workspace the run belongs to", () => {
    expect(recordTarget(run, undefined)).toEqual({ kind: "directory", dir: join(workspace, ".molab", "agents", "codex") });
  });

  it("outside molab, leaves the thread to Codex's own session store", () => {
    expect(recordTarget(root, undefined)).toEqual({ kind: "codex" });
  });

  it("a configured directory wins", () => {
    expect(recordTarget(run, "/var/log/codex")).toEqual({ kind: "directory", dir: "/var/log/codex" });
  });
});
