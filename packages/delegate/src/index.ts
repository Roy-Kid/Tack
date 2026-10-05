/**
 * `delegate`: hand open-ended work to a delegated agent runtime and keep the
 * run observable in the delegating session.
 *
 * Agent-neutral by construction: it speaks only DSH's subagent contract
 * (`SubagentProvider` / `SubagentRun` / `SubagentResult`, plus the proposed
 * `SubagentRun.events`). Which runtimes exist is configuration — each entry
 * names a registered DSH provider and says what it is good at.
 *
 * Tack's part is interpretation, never a second runtime interface:
 * - run events become `tool/ptc-dispatch*` sub-calls nested under this call
 *   (durable, rendered, never re-entering the supervisor model's context);
 * - the full run record is the call's presentation `meta`;
 * - the supervisor model receives only a compact summary.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type {} from "@tack/dsh-shims/subagent-events";

export const name = "tack-delegate";
export const inject = ["tools", "subagents"];

/** One delegated runtime the supervisor may choose. */
export interface AgentEntry {
  /** Registered DSH subagent provider name. */
  provider: string;
  /** One line the supervisor reads to decide when to use this agent. */
  description: string;
}

export interface DelegateConfig {
  toolName?: string;
  agents: Record<string, AgentEntry>;
}

type RunEvent = NonNullable<SubagentRun["events"]> extends AsyncIterable<infer E> ? E : never;

/**
 * Result convention every capable provider is asked to fill (passed through
 * DSH's own `outputSchema`, read back from `SubagentResult.structured`).
 * Generic across task kinds: code, research, analysis, files.
 */
export const DELEGATION_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "filesChanged"],
  properties: {
    status: { type: "string", enum: ["completed", "partial", "failed"] },
    summary: { type: "string", description: "What was done and the outcome, for the delegating agent." },
    filesChanged: { type: "array", items: { type: "string" }, description: "Workspace-relative paths created, modified, or deleted." },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode"],
        properties: { command: { type: "string" }, exitCode: { type: "integer" } },
      },
    },
    tests: {
      type: "object",
      additionalProperties: false,
      required: ["command", "passed"],
      properties: { command: { type: "string" }, passed: { type: "boolean" }, details: { type: "string" } },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "description"],
        properties: { path: { type: "string" }, description: { type: "string" } },
      },
    },
    followUps: { type: "array", items: { type: "string" } },
  },
} as const;

export interface DelegationReport {
  status: "completed" | "partial" | "failed";
  summary: string;
  filesChanged: string[];
  commands?: { command: string; exitCode: number }[];
  tests?: { command: string; passed: boolean; details?: string };
  artifacts?: { path: string; description: string }[];
  followUps?: string[];
}

/** The persisted record of one delegation (the call's `meta`; also the tool's canonical value). */
export interface DelegationRecord {
  agent: string;
  runId: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  stopReason: string;
  summary: string;
  report?: DelegationReport;
  /** The child's text answer when it returned no structured report. */
  text?: string;
  diagnostic?: string;
  toolCalls: number;
  filesChanged: string[];
  costUsd?: number;
  turns?: number;
}

interface ToolsService {
  register(definition: unknown): () => void;
}
interface SubagentsService {
  getProvider(name: string): SubagentProvider | undefined;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
interface DelegateContext {
  tools: ToolsService;
  subagents: SubagentsService;
  on(event: "subagent/provider-added", listener: (provider: SubagentProvider) => void): () => void;
  on(event: "subagent/provider-removed", listener: (name: string) => void): () => void;
  effect(execute: () => () => void, label?: string): void;
  logger: { info(message: string, ...args: unknown[]): void };
}

/** Exec fields this tool reads (DSH's ToolRunContext). */
interface DelegateExec {
  callId: string;
  rootCallId: string;
  agent?: Agent;
  signal: AbortSignal;
}

const DRAIN_GRACE_MS = 2_000;

export function validateConfig(config: unknown): Required<DelegateConfig> {
  const input = (config ?? {}) as Partial<DelegateConfig>;
  const agents = input.agents ?? {};
  if (typeof agents !== "object" || agents === null) throw new Error("tack-delegate: config.agents must be an object");
  for (const [agentName, entry] of Object.entries(agents)) {
    if (!/^[a-z][a-z0-9-]*$/.test(agentName)) throw new Error(`tack-delegate: agent name "${agentName}" must be lowercase letters, digits, and dashes`);
    if (typeof entry?.provider !== "string" || entry.provider === "") throw new Error(`tack-delegate: agents.${agentName}.provider is required`);
    if (typeof entry.description !== "string" || entry.description.trim() === "") {
      throw new Error(`tack-delegate: agents.${agentName}.description is required`);
    }
  }
  return { toolName: input.toolName ?? "delegate", agents };
}

/** JSON-normalize a value so a session append can never fail on payload shape. */
function json(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function prompt(task: string, context: string | undefined): string {
  const parts = [task.trim()];
  if (context !== undefined && context.trim() !== "") parts.push(`Context from the delegating agent:\n${context.trim()}`);
  parts.push(
    "Work autonomously until the task is done. When you finish, report what you changed (files), the commands you ran with their exit codes, and the result of any verification such as tests.",
  );
  return parts.join("\n\n");
}

function asReport(value: unknown): DelegationReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<DelegationReport>;
  if (typeof candidate.summary !== "string" || typeof candidate.status !== "string") return undefined;
  return { ...candidate, filesChanged: Array.isArray(candidate.filesChanged) ? candidate.filesChanged : [] } as DelegationReport;
}

function textOf(result: SubagentResult): string {
  return result.output
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** The compact, model-facing rendering of a delegation record. */
export function renderRecord(record: DelegationRecord): string {
  const lines = [`Delegated to ${record.agent}: ${record.status}.`, record.summary];
  if (record.filesChanged.length > 0) lines.push(`Files changed: ${record.filesChanged.join(", ")}`);
  const tests = record.report?.tests;
  if (tests !== undefined) lines.push(`Tests: \`${tests.command}\` ${tests.passed ? "passed" : "failed"}${tests.details ? ` (${tests.details})` : ""}`);
  if (record.report?.followUps?.length) lines.push(`Follow-ups: ${record.report.followUps.join("; ")}`);
  if (record.diagnostic !== undefined && record.status !== "completed") lines.push(`Diagnostic: ${record.diagnostic}`);
  return lines.filter((line) => line.trim() !== "").join("\n");
}

/** Mirror one run's events into the delegating session; returns the observed totals. */
async function interpret(
  events: AsyncIterable<RunEvent>,
  agentName: string,
  exec: DelegateExec,
  session: Agent["session"],
): Promise<{ toolCalls: number; filesChanged: Set<string>; costUsd?: number; turns?: number; close(): void }> {
  const open = new Map<string, { name: string; input: unknown }>();
  const observed: { toolCalls: number; filesChanged: Set<string>; costUsd?: number; turns?: number; close(): void } = {
    toolCalls: 0,
    filesChanged: new Set(),
    close: () => {
      for (const [id, call] of open) {
        session.append("tool/ptc-dispatch", {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId: subCallId(id),
          name: call.name,
          arguments: call.input,
          isError: true,
          content: [{ type: "text", text: "The delegated run ended before this call settled." }],
        } as never);
      }
      open.clear();
    },
  };
  const subCallId = (id: string) => `${exec.callId}:${agentName}:${id}`;
  for await (const event of events) {
    switch (event.type) {
      case "tool/start": {
        const call = { name: `${agentName}.${event.name}`, input: json(event.input) };
        open.set(event.id, call);
        observed.toolCalls += 1;
        session.append("tool/ptc-dispatch-start", {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId: subCallId(event.id),
          name: call.name,
          arguments: call.input,
        } as never);
        break;
      }
      case "tool/end": {
        const call = open.get(event.id);
        if (call === undefined) break;
        open.delete(event.id);
        session.append("tool/ptc-dispatch", {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId: subCallId(event.id),
          name: call.name,
          arguments: call.input,
          isError: event.isError,
          content: [{ type: "text", text: event.summary }],
        } as never);
        break;
      }
      case "file/changed":
        observed.filesChanged.add(event.path);
        break;
      case "usage":
        if (event.costUsd !== undefined) observed.costUsd = event.costUsd;
        if (event.turns !== undefined) observed.turns = event.turns;
        break;
      case "progress":
        break;
    }
  }
  return observed;
}

async function delegateOnce(
  ctx: DelegateContext,
  config: Required<DelegateConfig>,
  args: { agent: string; description: string; task: string; context?: string },
  exec: DelegateExec,
): Promise<DelegationRecord> {
  const parent = exec.agent;
  if (parent === undefined) throw new Error("delegate requires a calling agent");
  const entry = config.agents[args.agent];
  const provider = entry === undefined ? undefined : ctx.subagents.getProvider(entry.provider);
  if (entry === undefined || provider === undefined) throw new Error(`delegate: agent "${args.agent}" is not available`);

  const run = await ctx.subagents.start(entry.provider, {
    label: args.description,
    prompt: [{ type: "text", text: prompt(args.task, args.context) }],
    parent,
    signal: exec.signal,
    ...(provider.capabilities.outputSchema && { outputSchema: DELEGATION_RESULT_SCHEMA as never }),
  });
  try {
    const observing = run.events === undefined ? undefined : interpret(run.events, args.agent, exec, parent.session);
    const result = await run.result;
    let observed: Awaited<NonNullable<typeof observing>> | undefined;
    if (observing !== undefined) {
      observed = await Promise.race([observing, new Promise<undefined>((done) => setTimeout(() => done(undefined), DRAIN_GRACE_MS).unref())]);
      observed?.close();
    }
    if (result.stopReason === "aborted" && exec.signal.aborted) throw new Error("delegation cancelled");

    const report = asReport(result.structured);
    const text = textOf(result);
    const filesChanged = [...new Set([...(report?.filesChanged ?? []), ...(observed?.filesChanged ?? [])])].sort();
    const status: DelegationRecord["status"] =
      result.stopReason === "completed" ? (report?.status ?? "completed") : result.stopReason === "aborted" ? "cancelled" : "failed";
    return {
      agent: args.agent,
      runId: String(run.id),
      status,
      stopReason: result.stopReason,
      summary: report?.summary ?? (text || `The ${args.agent} run ended (${result.stopReason}).`),
      ...(report !== undefined && { report }),
      ...(report === undefined && text !== "" && { text }),
      ...(result.diagnostic !== undefined && { diagnostic: result.diagnostic }),
      toolCalls: observed?.toolCalls ?? 0,
      filesChanged,
      ...(observed?.costUsd !== undefined && { costUsd: observed.costUsd }),
      ...(observed?.turns !== undefined && { turns: observed.turns }),
    };
  } finally {
    await Promise.resolve(run.dispose()).catch(() => {});
  }
}

function definition(ctx: DelegateContext, config: Required<DelegateConfig>, available: readonly string[]) {
  const catalog = available.map((agentName) => `- ${agentName}: ${config.agents[agentName]!.description}`).join("\n");
  return defineTool({
    name: config.toolName,
    description: [
      "Delegate open-ended work to an autonomous agent runtime. The agent works in the session's workspace with its own tools and loop, then reports back; you receive a short structured summary, not its transcript.",
      "Give a self-contained task: the goal, relevant paths, constraints, and how to verify the result (for example the test command). Do not micromanage individual steps.",
      `Available agents:\n${catalog}`,
    ].join("\n\n"),
    parameters: {
      agent: { type: "string", required: true, enum: [...available], description: "Which agent to delegate to." },
      description: { type: "string", required: true, description: "A short (3-6 word) label for the delegated task, for display." },
      task: { type: "string", required: true, description: "The complete, self-contained task for the agent." },
      context: { type: "string", description: "Optional context the agent cannot discover itself (decisions, constraints, prior findings)." },
    },
    output: {
      schema: { type: "json" },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: renderRecord(value as DelegationRecord) }],
      presentationMeta: (_args: unknown, value: unknown) => value as never,
    },
    execute: (args: { agent: string; description: string; task: string; context?: string }, exec: DelegateExec) =>
      delegateOnce(ctx, config, args, exec) as never,
  } as never);
}

export function apply(ctx: DelegateContext, rawConfig: unknown): void {
  const config = validateConfig(rawConfig);
  const providers = new Set(Object.values(config.agents).map((entry) => entry.provider));
  let dispose: (() => void) | undefined;
  const mount = () => {
    dispose?.();
    dispose = undefined;
    const available = Object.keys(config.agents).filter((agentName) => ctx.subagents.getProvider(config.agents[agentName]!.provider) !== undefined);
    if (available.length === 0) {
      ctx.logger.info(`no delegated agent is available yet; "${config.toolName}" registers when one is`);
      return;
    }
    dispose = ctx.tools.register(definition(ctx, config, available));
  };
  ctx.effect(() => () => {
    dispose?.();
    dispose = undefined;
  }, "tack-delegate: tool");
  ctx.on("subagent/provider-added", (provider) => {
    if (providers.has(provider.name)) mount();
  });
  ctx.on("subagent/provider-removed", (providerName) => {
    if (providers.has(providerName)) mount();
  });
  mount();
}
