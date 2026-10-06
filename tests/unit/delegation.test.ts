/**
 * The pure parts of delegation: the delegate tool's config and model-facing
 * rendering, the Claude provider's permission tiers, SDK message translation,
 * result mapping, and the supervisor's tool mask.
 */
import { describe, expect, it } from "@rstest/core";
import { apply as applyDelegate, jobOutcome, renderRecord, renderValue, validateConfig, type DelegationRecord } from "../../packages/delegate/src/index.js";
import { resolveConfig, unansweredAsk } from "../../packages/agent-claude/src/index.js";
import { EventQueue, EventTranslator } from "../../packages/agent-claude/src/events.js";
import { decide, effectiveTier } from "../../packages/agent-claude/src/permissions.js";
import { settle } from "../../packages/agent-claude/src/run.js";
import { apply as applyToolMask } from "../../packages/plugins/src/tool-mask.js";
import { cardModel, formatFooter } from "../../packages/delegate/src/view.js";

describe("delegate config", () => {
  it("defaults the tool name and accepts named agents", () => {
    const config = validateConfig({ agents: { claude: { provider: "claude", description: "A workspace agent." } } });
    expect(config.toolName).toBe("delegate");
    expect(Object.keys(config.agents)).toEqual(["claude"]);
  });

  it("rejects malformed agent entries", () => {
    expect(() => validateConfig({ agents: { Claude: { provider: "claude", description: "x" } } })).toThrow(/lowercase/);
    expect(() => validateConfig({ agents: { claude: { description: "x" } } })).toThrow(/provider is required/);
    expect(() => validateConfig({ agents: { claude: { provider: "claude", description: " " } } })).toThrow(/description is required/);
  });
});

describe("delegation record rendering", () => {
  const record: DelegationRecord = {
    agent: "claude",
    runId: "run-1",
    status: "completed",
    stopReason: "completed",
    summary: "Fixed the bug.",
    report: {
      status: "completed",
      summary: "Fixed the bug.",
      filesChanged: ["sum.js"],
      tests: { command: "npm test", passed: true },
      followUps: ["Add a regression test"],
    },
    toolCalls: 3,
    filesChanged: ["sum.js"],
  };

  it("gives the model a compact summary", () => {
    expect(renderRecord(record)).toBe(
      ["Delegated to claude: completed.", "Fixed the bug.", "Files changed: sum.js", "Tests: `npm test` passed", "Follow-ups: Add a regression test"].join("\n"),
    );
  });

  it("includes the diagnostic only when the run did not complete", () => {
    expect(renderRecord({ ...record, diagnostic: "noise" })).not.toContain("noise");
    expect(renderRecord({ ...record, status: "failed", diagnostic: "Claude reached its turn limit." })).toContain("Diagnostic: Claude reached its turn limit.");
  });
});

describe("Claude permission tiers", () => {
  const workspace = "/work/repo";

  it("always allows reading", () => {
    for (const tier of ["read-only", "edit", "full"] as const) expect(decide(tier, workspace, "Read", { file_path: "/etc/hosts" }).kind).toBe("allow");
  });

  it("read-only denies everything that changes something", () => {
    expect(decide("read-only", workspace, "Edit", { file_path: "a.js" }).kind).toBe("deny");
    expect(decide("read-only", workspace, "Bash", { command: "ls" }).kind).toBe("deny");
  });

  it("edit allows edits inside the workspace only and asks for commands", () => {
    expect(decide("edit", workspace, "Edit", { file_path: "/work/repo/src/a.js" }).kind).toBe("allow");
    expect(decide("edit", workspace, "Write", { file_path: "src/new.js" }).kind).toBe("allow");
    expect(decide("edit", workspace, "Write", { file_path: "/work/other/a.js" }).kind).toBe("deny");
    expect(decide("edit", workspace, "Edit", { file_path: "../escape.js" }).kind).toBe("deny");
    expect(decide("edit", workspace, "Bash", { command: "npm test" })).toEqual({ kind: "ask", reason: "Claude wants to run Bash: npm test" });
  });

  it("full allows everything", () => {
    expect(decide("full", workspace, "Bash", { command: "rm -rf build" }).kind).toBe("allow");
  });
});

describe("Claude provider config", () => {
  it("defaults to the edit tier, denying unanswerable asks", () => {
    const config = resolveConfig({ configDir: "/tmp/claude" });
    expect(config).toMatchObject({ providerName: "claude", permissions: "edit", whenNoApprover: "deny", apiKeyRef: "ANTHROPIC_API_KEY" });
  });

  it("rejects invalid values", () => {
    expect(() => resolveConfig({ permissions: "root" as never })).toThrow(/permissions/);
    expect(() => resolveConfig({ maxTurns: 0 })).toThrow(/maxTurns/);
    expect(() => resolveConfig({ whenNoApprover: "ask" as never })).toThrow(/whenNoApprover/);
  });
});

describe("Claude message translation", () => {
  it("surfaces tool calls and text, hides the result tool and inner agents", () => {
    const translator = new EventTranslator();
    expect(
      translator.translate({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: " Looking. " },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.js" } },
            { type: "tool_use", id: "t2", name: "StructuredOutput", input: {} },
          ],
        },
      }),
    ).toEqual([
      { type: "progress", text: "Looking." },
      { type: "tool/start", id: "t1", name: "Read", input: { file_path: "a.js" } },
    ]);
    expect(
      translator.translate({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line 1\n  line 2" }] },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
      }),
    ).toEqual([{ type: "tool/end", id: "t1", isError: false, summary: "line 1 line 2" }]);
    expect(translator.translate({ type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "text", text: "inner" }] } })).toEqual([]);
    expect(translator.translate({ type: "result", total_cost_usd: 0.25, num_turns: 4 })).toEqual([{ type: "usage", costUsd: 0.25, turns: 4 }]);
  });

  it("queues events for one consumer until closed", async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    const consumed = (async () => {
      for await (const item of queue) seen.push(item);
    })();
    queue.push(2);
    queue.close();
    queue.push(3);
    await consumed;
    expect(seen).toEqual([1, 2]);
  });
});

describe("Claude result mapping", () => {
  const base = { type: "result", duration_ms: 1, duration_api_ms: 1, num_turns: 2, total_cost_usd: 0, stop_reason: null, permission_denials: [] };

  it("completes with the structured report", () => {
    const result = settle({ ...base, subtype: "success", is_error: false, result: "Done.", structured_output: { status: "completed" } } as never, true);
    expect(result).toEqual({ output: [{ type: "text", text: "Done." }], stopReason: "completed", structured: { status: "completed" } });
  });

  it("says when a requested report is missing", () => {
    expect(settle({ ...base, subtype: "success", is_error: false, result: "Done." } as never, true).diagnostic).toMatch(/structured report/);
  });

  it("maps limits and failures to an error with a diagnostic", () => {
    const limited = settle({ ...base, subtype: "error_max_turns", is_error: true, errors: [] } as never, true);
    expect(limited.stopReason).toBe("error");
    expect(limited.diagnostic).toBe("Claude reached its turn limit.");
    expect(settle(undefined, false)).toMatchObject({ stopReason: "error", diagnostic: "Claude ended without a result." });
  });

  it("maps a refusal", () => {
    expect(settle({ ...base, subtype: "success", is_error: false, result: "No.", stop_reason: "refusal" } as never, false).stopReason).toBe("refusal");
  });
});

/** A fake agent whose tool registry knows `visible` and records live restrictions. */
function fakeAgent(sessionId: string, visible: readonly string[]) {
  const active = new Set<string>();
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
        restrict: ({ deny }: { deny: readonly string[] }) => {
          const name = deny[0]!;
          if (!visible.includes(name)) throw new Error(`unknown tool ${name}`);
          active.add(name);
          return () => active.delete(name);
        },
      },
    },
  };
  return { agent, masked: () => [...active].sort() };
}

function maskHarness(config: Parameters<typeof applyToolMask>[1], presets: Map<unknown, string> = new Map()) {
  const listeners = new Map<string, (...args: never[]) => void>();
  applyToolMask(
    {
      get: () => ({ composedPreset: (ctx: unknown) => presets.get(ctx) }),
      on: (event: string, listener: (...args: never[]) => void) => (listeners.set(event, listener), () => {}),
    } as never,
    config,
  );
  return (event: string, ...args: unknown[]) => (listeners.get(event) as ((...args: unknown[]) => void) | undefined)?.(...args);
}

describe("tool mask", () => {
  it("hides the denied tools each agent can see", () => {
    const emit = maskHarness({ deny: ["write", "edit", "bash"] });
    const { agent, masked } = fakeAgent("s1", ["read", "write", "edit"]);
    emit("agent/created", { agent });
    expect(masked()).toEqual(["edit", "write"]);
  });

  it("with a preset, masks only that preset's agents and follows a switch", () => {
    const presets = new Map<unknown, string>();
    const emit = maskHarness({ deny: ["write", "edit"], preset: "supervise" }, presets);
    const supervised = fakeAgent("s1", ["read", "write", "edit"]);
    const standard = fakeAgent("s2", ["read", "write", "edit"]);
    presets.set(supervised.agent.ctx, "supervise");
    presets.set(standard.agent.ctx, "standard");
    emit("agent/created", { agent: supervised.agent });
    emit("agent/created", { agent: standard.agent });
    expect(supervised.masked()).toEqual(["edit", "write"]);
    expect(standard.masked()).toEqual([]);

    emit("agent-preset/selected", "s1", "standard");
    emit("agent-preset/selected", "s2", "supervise");
    expect(supervised.masked()).toEqual([]);
    expect(standard.masked()).toEqual(["edit", "write"]);
  });
});

describe("Claude tier under the session's sandbox mode", () => {
  it("caps to read-only, grants asks in full access, and never raises the tier", () => {
    expect(effectiveTier("edit", "read-only")).toEqual({ tier: "read-only", allowAsks: false });
    expect(effectiveTier("edit", "workspace-write")).toEqual({ tier: "edit", allowAsks: false });
    expect(effectiveTier("edit", undefined)).toEqual({ tier: "edit", allowAsks: false });
    expect(effectiveTier("edit", "danger-full-access")).toEqual({ tier: "edit", allowAsks: true });
    expect(effectiveTier("read-only", "danger-full-access")).toEqual({ tier: "read-only", allowAsks: false });
    expect(effectiveTier("full", "read-only")).toEqual({ tier: "read-only", allowAsks: false });
  });
});

describe("delegate card", () => {
  const record: DelegationRecord = {
    agent: "claude",
    runId: "r",
    status: "completed",
    stopReason: "completed",
    summary: "Fixed sum.\nDetails follow.",
    report: { status: "completed", summary: "Fixed sum.", filesChanged: ["sum.js"], commands: [{ command: "npm test", exitCode: 0 }], tests: { command: "npm test", passed: true } },
    toolCalls: 3,
    filesChanged: ["sum.js"],
    costUsd: 0.0412,
    turns: 5,
  };
  const args = JSON.stringify({ agent: "claude", description: "Fix the test", task: "..." });

  it("shows progress while running", () => {
    expect(cardModel("start", { argsRaw: args, subCalls: [{}, {}] })).toMatchObject({ state: "running", agent: "claude", headline: "Fix the test · 2 steps" });
    expect(cardModel("start", { argsRaw: args })).toMatchObject({ headline: "Fix the test · starting" });
    expect(cardModel("preparing", {}).state).toBe("preparing");
  });

  it("shows the record when finished", () => {
    const model = cardModel("result", { argsRaw: args, meta: record });
    expect(model).toMatchObject({
      state: "completed",
      headline: "Fixed sum.",
      filesChanged: ["sum.js"],
      commands: [{ command: "npm test", exitCode: 0 }],
      tests: { command: "npm test", passed: true },
      footer: "3 tool calls · $0.04 · 5 turns",
      expandable: true,
    });
  });

  it("adds the diagnostic for runs that did not complete", () => {
    expect(cardModel("result", { meta: { ...record, status: "failed", diagnostic: "Turn limit." } }).detail).toContain("Turn limit.");
  });

  it("falls back to the error when there is no record", () => {
    expect(cardModel("result", { argsRaw: args, isError: true, content: [{ type: "text", text: "delegation cancelled" }] })).toMatchObject({ state: "cancelled", headline: "delegation cancelled" });
    expect(cardModel("result", { isError: true, error: { message: "delegate: agent \"x\" is not available" } })).toMatchObject({ state: "error", agent: "agent" });
  });

  it("formats small costs and singular counts", () => {
    expect(formatFooter({ toolCalls: 1, costUsd: 0.0031, turns: 1 })).toBe("1 tool call · $0.0031 · 1 turn");
    expect(formatFooter({ toolCalls: 0 })).toBe("0 tool calls");
  });
});

/** A delegate tool mounted on fake services, with one scripted run per start. */
function delegateHarness(config: Record<string, unknown>, script: { events?: unknown[]; result?: Record<string, unknown>; hold?: boolean; throws?: string } = {}) {
  const registered: { parameters: { properties: Record<string, unknown> }; execute(args: unknown, exec: unknown): Promise<unknown> }[] = [];
  const jobs: { spec: { kind: string; label: string; owner: unknown; run(job: unknown): { cancel(reason?: string): void; done: Promise<unknown> } } }[] = [];
  const starts: { signal: AbortSignal }[] = [];
  const provider = { name: "claude", capabilities: { outputSchema: true } };
  const ctx = {
    get: (name: string) =>
      name === "jobs"
        ? {
            start: (spec: (typeof jobs)[number]["spec"]) => {
              jobs.push({ spec });
              return `delegate-${jobs.length}`;
            },
          }
        : undefined,
    tools: { register: (definition: (typeof registered)[number]) => (registered.push(definition), () => {}) },
    subagents: {
      getProvider: (name: string) => (name === "claude" ? provider : undefined),
      start: async (_name: string, request: { signal: AbortSignal }) => {
        starts.push(request);
        if (script.throws !== undefined) throw new Error(script.throws);
        const result = script.hold
          ? new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ output: [], stopReason: "aborted" })))
          : Promise.resolve(script.result ?? { output: [{ type: "text", text: "Done." }], stopReason: "completed", structured: { status: "completed", summary: "All done.", filesChanged: ["a.js"] } });
        return {
          id: "run-1",
          result,
          dispose: async () => {},
          events: (async function* () {
            for (const event of script.events ?? []) yield event;
          })(),
        };
      },
    },
    on: () => () => {},
    effect: () => {},
    logger: { info: () => {} },
  };
  applyDelegate(ctx as never, { agents: { claude: { provider: "claude", description: "Claude." } }, ...config });
  const parent = { id: "session-1", session: { append: () => {} } };
  const exec = { callId: "c1", rootCallId: "c1", agent: parent, signal: new AbortController().signal };
  const job = { lines: [] as string[], progress: [] as string[] };
  const handle = { append: (text: string) => job.lines.push(text.trimEnd()), updateProgress: (line: string) => job.progress.push(line) };
  return { tool: () => registered.at(-1)!, jobs, starts, exec, job, handle };
}

describe("background delegation", () => {
  const args = { agent: "claude", description: "Long task", task: "Do it.", background: true };

  it("offers the background parameter only when configured", () => {
    expect(delegateHarness({}).tool().parameters.properties).not.toHaveProperty("background");
    expect(delegateHarness({ background: true }).tool().parameters.properties).toHaveProperty("background");
  });

  it("ignores background when the composition does not allow it", async () => {
    const harness = delegateHarness({});
    const value = (await harness.tool().execute(args, harness.exec)) as { status: string };
    expect(harness.jobs).toHaveLength(0);
    expect(value.status).toBe("completed");
  });

  it("starts a job owned by the session and returns at once", async () => {
    const harness = delegateHarness({ background: true });
    const value = await harness.tool().execute(args, harness.exec);
    expect(value).toEqual({ agent: "claude", description: "Long task", background: true, jobId: "delegate-1", status: "running" });
    expect(harness.jobs[0]!.spec).toMatchObject({ kind: "delegate", label: "claude: Long task", owner: "session-1" });
    expect(harness.starts).toHaveLength(0);
    expect(renderValue(value as never)).toContain("job delegate-1");
  });

  it("logs the run into the job and settles with the rendered report", async () => {
    const harness = delegateHarness(
      { background: true },
      {
        events: [
          { type: "progress", text: "Looking around." },
          { type: "tool/start", id: "t1", name: "Bash", input: { command: "npm test" } },
          { type: "tool/end", id: "t1", isError: false, summary: "1 passing" },
        ],
      },
    );
    await harness.tool().execute(args, harness.exec);
    const outcome = await harness.jobs[0]!.spec.run(harness.handle).done;
    expect(harness.job.lines).toEqual(["Looking around.", "→ claude.Bash npm test", "✓ claude.Bash: 1 passing"]);
    expect(harness.job.progress).toEqual(["claude.Bash · 1 step"]);
    expect(outcome).toEqual({ status: "completed", result: expect.stringContaining("Delegated to claude: completed.\nAll done.\nFiles changed: a.js") });
  });

  it("maps a failed run to a failed job with its diagnostic", async () => {
    const harness = delegateHarness({ background: true }, { result: { output: [], stopReason: "error", diagnostic: "Claude reached its turn limit." } });
    await harness.tool().execute(args, harness.exec);
    expect(await harness.jobs[0]!.spec.run(harness.handle).done).toMatchObject({ status: "failed", detail: "Claude reached its turn limit." });
  });

  it("job_kill cancels the run", async () => {
    const harness = delegateHarness({ background: true }, { hold: true });
    await harness.tool().execute(args, harness.exec);
    const hooks = harness.jobs[0]!.spec.run(harness.handle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks.cancel("stop");
    expect(harness.starts[0]!.signal.aborted).toBe(true);
    expect(await hooks.done).toMatchObject({ status: "killed", detail: "delegation cancelled" });
  });

  it("never rejects when the run cannot start", async () => {
    const harness = delegateHarness({ background: true }, { throws: "agent-claude: no Anthropic key" });
    await harness.tool().execute(args, harness.exec);
    expect(await harness.jobs[0]!.spec.run(harness.handle).done).toEqual({ status: "failed", detail: "agent-claude: no Anthropic key" });
  });

  it("maps outcomes for every record status", () => {
    const record: DelegationRecord = { agent: "claude", runId: "r", status: "partial", stopReason: "completed", summary: "Half.", toolCalls: 0, filesChanged: [] };
    expect(jobOutcome(record, false)).toMatchObject({ status: "completed", detail: "partially completed" });
    expect(jobOutcome({ ...record, status: "cancelled" }, false).status).toBe("killed");
    expect(jobOutcome({ ...record, status: "completed" }, true).status).toBe("killed");
  });

  it("shows a background card", () => {
    expect(cardModel("result", { meta: { agent: "claude", description: "Long task", background: true, jobId: "delegate-2", status: "running" } })).toMatchObject({
      state: "background",
      headline: "Running in the background · job delegate-2",
    });
  });

  it("lets whenNoApprover decide asks posed outside a turn", () => {
    expect(unansweredAsk(new Error("approval.request() outside an open turn: …"))).toBe("unavailable");
    expect(unansweredAsk(new Error("boom"))).toBe("rejected");
  });
});
