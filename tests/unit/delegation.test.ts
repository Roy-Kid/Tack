/**
 * The pure parts of delegation: the delegate tool's config and model-facing
 * rendering, the Claude provider's permission tiers, SDK message translation,
 * result mapping, and the supervisor's tool mask.
 */
import { describe, expect, it } from "@rstest/core";
import { renderRecord, validateConfig, type DelegationRecord } from "../../packages/delegate/src/index.js";
import { resolveConfig } from "../../packages/agent-claude/src/index.js";
import { EventQueue, EventTranslator } from "../../packages/agent-claude/src/events.js";
import { decide } from "../../packages/agent-claude/src/permissions.js";
import { settle } from "../../packages/agent-claude/src/run.js";
import { apply as applyToolMask } from "../../packages/plugins/src/tool-mask.js";

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

describe("tool mask", () => {
  it("hides denied tools that exist from every agent created", () => {
    let created: ((event: { agent: { ctx: { tools: never } } }) => void) | undefined;
    const restricted: (readonly string[])[] = [];
    const tools = { schemas: () => [{ name: "read" }, { name: "write" }, { name: "edit" }], restrict: () => () => {} };
    applyToolMask({ tools, on: (_event: string, listener: unknown) => ((created = listener as never), () => {}) } as never, { deny: ["write", "edit", "bash"] });
    created!({ agent: { ctx: { tools: { schemas: () => [], restrict: (filter: { deny: readonly string[] }) => (restricted.push(filter.deny), () => {}) } as never } } });
    expect(restricted).toEqual([["write", "edit"]]);
  });
});
