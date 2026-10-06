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
import type { BackgroundDelegation, DelegationRecord, DelegationReport } from "./record.js";

export type { BackgroundDelegation, DelegationRecord, DelegationReport } from "./record.js";

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
  /** Offer `background`: the run becomes a job of the session and the call returns at once. Only where the host outlives the turn. */
  background?: boolean;
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

interface ToolsService {
  register(definition: unknown): () => void;
}
interface SubagentsService {
  getProvider(name: string): SubagentProvider | undefined;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
/** The parts of DSH's jobs service a background delegation uses. */
export interface JobHandle {
  append(text: string, options?: { channel?: "stdout" | "stderr" | "log" }): void;
  updateProgress(line: string): void;
}
export interface JobOutcome {
  status: "completed" | "killed" | "failed";
  detail?: string;
  result?: string;
}
interface JobsService {
  start(spec: {
    kind: string;
    label: string;
    owner: unknown;
    run(job: JobHandle): { cancel(reason?: string): void; done: Promise<JobOutcome> };
  }): string;
}

interface DelegateContext {
  /** Optional services: the jobs registry serves background delegations. */
  get(name: "jobs"): JobsService | undefined;
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
  if (input.background !== undefined && typeof input.background !== "boolean") throw new Error("tack-delegate: config.background must be a boolean");
  return { toolName: input.toolName ?? "delegate", background: input.background ?? false, agents };
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

/** Where one run's activity goes: nested sub-calls in the session, or a background job's log. */
interface RunSink {
  toolStart(id: string, name: string, input: unknown): void;
  toolEnd(id: string, name: string, input: unknown, isError: boolean, summary: string): void;
  progress(text: string): void;
  /** A call the run ended without settling. */
  unsettled(id: string, name: string, input: unknown): void;
}

interface Observed {
  toolCalls: number;
  filesChanged: Set<string>;
  costUsd?: number;
  turns?: number;
  close(): void;
}

/** Nested `tool/ptc-dispatch*` sub-calls under the delegate call (durable; needs the call's open turn). */
function sessionSink(session: Agent["session"], exec: DelegateExec, agentName: string): RunSink {
  const subCallId = (id: string) => `${exec.callId}:${agentName}:${id}`;
  const end = (id: string, name: string, input: unknown, isError: boolean, text: string) =>
    session.append("tool/ptc-dispatch", {
      rootCallId: exec.rootCallId,
      parentCallId: exec.callId,
      subCallId: subCallId(id),
      name,
      arguments: input,
      isError,
      content: [{ type: "text", text }],
    } as never);
  return {
    toolStart: (id, name, input) =>
      session.append("tool/ptc-dispatch-start", { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId: subCallId(id), name, arguments: input } as never),
    toolEnd: end,
    progress: () => {},
    unsettled: (id, name, input) => end(id, name, input, true, "The delegated run ended before this call settled."),
  };
}

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/** The one argument that identifies a call at a glance (a command, a path, a pattern). */
function brief(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"]) {
    if (typeof fields[key] === "string") return clip(fields[key], 120);
  }
  return clip(JSON.stringify(input), 120);
}

/** Transient log lines and a progress line on a background job. */
export function jobSink(job: JobHandle): RunSink {
  let steps = 0;
  const log = (line: string) => job.append(`${line}\n`, { channel: "log" });
  return {
    toolStart: (_id, name, input) => {
      steps += 1;
      log(`→ ${name}${brief(input) === "" ? "" : ` ${brief(input)}`}`);
      job.updateProgress(`${name} · ${steps} step${steps === 1 ? "" : "s"}`);
    },
    toolEnd: (_id, name, _input, isError, summary) => log(`${isError ? "✗" : "✓"} ${name}${summary.trim() === "" ? "" : `: ${clip(summary, 200)}`}`),
    progress: (text) => log(clip(text, 400)),
    unsettled: (_id, name) => log(`✗ ${name}: the run ended before this call settled`),
  };
}

/** Consume one run's events into a sink; returns the observed totals. */
async function observe(events: AsyncIterable<RunEvent>, agentName: string, sink: RunSink): Promise<Observed> {
  const open = new Map<string, { name: string; input: unknown }>();
  const observed: Observed = {
    toolCalls: 0,
    filesChanged: new Set(),
    close: () => {
      for (const [id, call] of open) sink.unsettled(id, call.name, call.input);
      open.clear();
    },
  };
  for await (const event of events) {
    switch (event.type) {
      case "tool/start": {
        const call = { name: `${agentName}.${event.name}`, input: json(event.input) };
        open.set(event.id, call);
        observed.toolCalls += 1;
        sink.toolStart(event.id, call.name, call.input);
        break;
      }
      case "tool/end": {
        const call = open.get(event.id);
        if (call === undefined) break;
        open.delete(event.id);
        sink.toolEnd(event.id, call.name, call.input, event.isError, event.summary);
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
        sink.progress(event.text);
        break;
    }
  }
  return observed;
}

type DelegateArgs = { agent: string; description: string; task: string; context?: string; background?: boolean };

function resolveAgent(ctx: DelegateContext, config: Required<DelegateConfig>, agentName: string): { entry: AgentEntry; provider: SubagentProvider } {
  const entry = config.agents[agentName];
  const provider = entry === undefined ? undefined : ctx.subagents.getProvider(entry.provider);
  if (entry === undefined || provider === undefined) throw new Error(`delegate: agent "${agentName}" is not available`);
  return { entry, provider };
}

/** Run one delegation to its record: start, observe, settle, dispose. `cancelled` when `signal` ended it. */
async function runDelegation(
  ctx: DelegateContext,
  config: Required<DelegateConfig>,
  args: DelegateArgs,
  parent: Agent,
  signal: AbortSignal,
  sink: RunSink,
): Promise<DelegationRecord> {
  const { entry, provider } = resolveAgent(ctx, config, args.agent);
  const run = await ctx.subagents.start(entry.provider, {
    label: args.description,
    prompt: [{ type: "text", text: prompt(args.task, args.context) }],
    parent,
    signal,
    ...(provider.capabilities.outputSchema && { outputSchema: DELEGATION_RESULT_SCHEMA as never }),
  });
  try {
    const observing = run.events === undefined ? undefined : observe(run.events, args.agent, sink);
    const result = await run.result;
    let observed: Observed | undefined;
    if (observing !== undefined) {
      observed = await Promise.race([observing, new Promise<undefined>((done) => setTimeout(() => done(undefined), DRAIN_GRACE_MS).unref())]);
      observed?.close();
    }
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

/** A settled delegation as a background job's outcome; `result` is what `job_output` gives the model. */
export function jobOutcome(record: DelegationRecord, killed: boolean): JobOutcome {
  const result = renderRecord(record);
  if (killed || record.status === "cancelled") return { status: "killed", detail: "delegation cancelled", result };
  if (record.status === "failed") return { status: "failed", detail: clip(record.diagnostic ?? record.summary, 300), result };
  return { status: "completed", ...(record.status === "partial" && { detail: "partially completed" }), result };
}

function startBackground(ctx: DelegateContext, config: Required<DelegateConfig>, args: DelegateArgs, parent: Agent): BackgroundDelegation {
  const jobs = ctx.get("jobs");
  if (jobs === undefined) throw new Error("delegate: background delegation needs the jobs service; this composition has none");
  resolveAgent(ctx, config, args.agent);
  const jobId = jobs.start({
    kind: "delegate",
    label: `${args.agent}: ${args.description}`,
    owner: parent.id,
    run: (job) => {
      const controller = new AbortController();
      const done = runDelegation(ctx, config, args, parent, controller.signal, jobSink(job)).then(
        (record) => jobOutcome(record, controller.signal.aborted),
        (error: unknown): JobOutcome =>
          controller.signal.aborted
            ? { status: "killed", detail: "delegation cancelled" }
            : { status: "failed", detail: clip(error instanceof Error ? error.message : String(error), 300) },
      );
      return { cancel: (reason?: string) => controller.abort(new Error(reason ?? "delegation killed")), done };
    },
  });
  return { agent: args.agent, description: args.description, background: true, jobId: String(jobId), status: "running" };
}

async function delegate(ctx: DelegateContext, config: Required<DelegateConfig>, args: DelegateArgs, exec: DelegateExec): Promise<DelegationRecord | BackgroundDelegation> {
  const parent = exec.agent;
  if (parent === undefined) throw new Error("delegate requires a calling agent");
  if (args.background === true && config.background) return startBackground(ctx, config, args, parent);
  const record = await runDelegation(ctx, config, args, parent, exec.signal, sessionSink(parent.session, exec, args.agent));
  if (record.status === "cancelled" && exec.signal.aborted) throw new Error("delegation cancelled");
  return record;
}

/** The model-facing text of the tool's value. */
export function renderValue(value: DelegationRecord | BackgroundDelegation): string {
  if ("background" in value) {
    return `Started a background delegation to ${value.agent} as job ${value.jobId}. You will get a notice when it finishes; read its report with job_output.`;
  }
  return renderRecord(value);
}

function definition(ctx: DelegateContext, config: Required<DelegateConfig>, available: readonly string[]) {
  const catalog = available.map((agentName) => `- ${agentName}: ${config.agents[agentName]!.description}`).join("\n");
  return defineTool({
    name: config.toolName,
    description: [
      "Delegate open-ended work to an autonomous agent runtime. The agent works in the session's workspace with its own tools and loop, then reports back; you receive a short structured summary, not its transcript.",
      "Give a self-contained task: the goal, relevant paths, constraints, and how to verify the result (for example the test command). Do not micromanage individual steps.",
      ...(config.background
        ? ["For long work, set background: the call returns at once, you keep helping the user, and a notice arrives when the agent finishes; then read its report with job_output (job_kill stops it)."]
        : []),
      `Available agents:\n${catalog}`,
    ].join("\n\n"),
    parameters: {
      agent: { type: "string", required: true, enum: [...available], description: "Which agent to delegate to." },
      description: { type: "string", required: true, description: "A short (3-6 word) label for the delegated task, for display." },
      task: { type: "string", required: true, description: "The complete, self-contained task for the agent." },
      context: { type: "string", description: "Optional context the agent cannot discover itself (decisions, constraints, prior findings)." },
      ...(config.background && {
        background: { type: "boolean", description: "Run in the background and return at once; a notice arrives when it finishes." },
      }),
    },
    output: {
      schema: { type: "json" },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: renderValue(value as DelegationRecord | BackgroundDelegation) }],
      presentationMeta: (_args: unknown, value: unknown) => value as never,
    },
    execute: (args: DelegateArgs, exec: DelegateExec) => delegate(ctx, config, args, exec) as never,
  } as never);
}

/**
 * Register the tool for the configured agents. A row with no agents registers
 * nothing: web compositions mount one at the root so the runtime serves this
 * package's browser half (the delegate card) wherever the tool itself lives.
 */
export function apply(ctx: DelegateContext, rawConfig: unknown): void {
  const config = validateConfig(rawConfig);
  if (Object.keys(config.agents).length === 0) return;
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
