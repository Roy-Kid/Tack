/**
 * The only place `@tack/research` touches DeepSeek Harness: tool registration,
 * waking a supervising session, the workers port over DSH's subagent service
 * (`research_dispatch` starts workers through it; DSH runs, cancels and
 * settles them, and delivers the settlement to the supervisor), and the hooks
 * that steer a research session's native subagent tools to `research_dispatch`
 * and keep a worker session to a worker's tools.
 */
import { userInfo } from "node:os";
import { boundContextSummary, createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type Confinement, confinedRefusal, confinementProblem } from "../confine.js";
import type { DelegationRecord } from "../delegation/model.js";
import type { DelegationStore } from "../delegation/store.js";
import { dryRunOpen, dryRunRefusal, executionOf, GATE_DRYRUN, gateTrailer, renderTrailer } from "../gates.js";
import { clip, errorMessage } from "../text.js";
import type { ToolSpec, ToolValue, WorkerKind, WorkerOutcome, WorkersPort, WorkerStartRequest } from "../tools/types.js";
import type { Waker } from "../watcher.js";
import { dispatchRefusal, isResearchTool, isWorkerTool, WORKER_TOOLS, workerScopeRefusal, type WorkerLedger } from "../workers.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "research-wake": { kind: "research-wake" } & ContextFormed;
  }
}

/** The DSH execution fields the research tools read (DSH's ToolRunContext). */
interface ResearchExec {
  signal: AbortSignal;
  agent?: Agent;
  concludeTurn(): void;
}

/**
 * A tool value as plain JSON. DSH refuses a value that does not survive a JSON
 * round trip (an `undefined` field, a class instance), after the tool has
 * already acted — so the value is normalized here, once, for every tool.
 */
export function losslessValue(value: ToolValue): ToolValue {
  return JSON.parse(JSON.stringify(value)) as ToolValue;
}

/** The delegation a call names, when it names one. */
function namedDelegation(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const delegation = (args as { delegation?: unknown }).delegation;
  return typeof delegation === "string" && delegation.trim() !== "" ? delegation.trim() : undefined;
}

/**
 * Who answers and approves in a headless run: `TACK_BY`, else the OS user.
 * Never the model's choice: `research_resume` records this identity, not
 * its `by` argument, on every answer and approval.
 */
export function callerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const by = env.TACK_BY?.trim();
  if (by !== undefined && by !== "") return by;
  try {
    return userInfo().username;
  } catch {
    return "operator";
  }
}

export interface ToolOptions {
  /** Hears which delegation a calling session works on. */
  focus?: (sessionId: string, delegation: string) => void;
  /** The person behind the process (default {@link callerIdentity}), read at each call. */
  caller?: () => string;
}

/**
 * A runtime-neutral spec as a DSH tool. The value's text is what the model
 * reads; its meta is persisted. `focus` hears which delegation a calling
 * session works on: the one a successful call names, or the one it opened.
 */
export function toDshTool(spec: ToolSpec<never>, options: ToolOptions = {}): unknown {
  const { focus, caller = callerIdentity } = options;
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: "json" },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: (value as ToolValue).text }],
      presentationMeta: (_args: unknown, value: unknown) => ((value as ToolValue).meta ?? null) as never,
    },
    execute: async (args: never, exec: ResearchExec) => {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id);
      const value = await spec.execute(args, {
        signal: exec.signal,
        caller: caller(),
        concludeTurn: () => exec.concludeTurn(),
        ...(sessionId !== undefined && {
          sessionId,
          ...(focus !== undefined && { focus: (delegation: string) => focus(sessionId, delegation) }),
        }),
      });
      const named = namedDelegation(args);
      if (sessionId !== undefined && named !== undefined) focus?.(sessionId, named);
      return losslessValue(value) as never;
    },
  } as never);
}

// ── Worker hooks ─────────────────────────────────────────────────────────────

/** The DSH tool-call fields the worker hooks read (DSH's ToolExecution; the session header is dsh-session's SessionHeader). */
interface HookedCall {
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: { readonly session: { readonly id: unknown; readonly header?: { readonly origin?: unknown; readonly parentSession?: unknown } } };
}

/** The fields of DSH's `subagent/end` payload (SubagentRunEndInfo) the ledger reads. */
interface SubagentEndInfo {
  readonly id: unknown;
  readonly stopReason: string;
  readonly lastAssistantMessage?: readonly { readonly type: string; readonly text?: string }[];
}

type PreDecision = { kind: string };

/** The parts of the plugin context the worker hooks use. */
export interface WorkerHookContext {
  on(event: "tools/pre-execute", listener: (exec: HookedCall, next: () => Promise<PreDecision>) => Promise<PreDecision>): () => void;
  on(event: "subagent/end", listener: (info: SubagentEndInfo) => Promise<void>): () => void;
}

const USE_DISPATCH = { name: "TackUseDispatch", code: "TACK_USE_DISPATCH" };
const WORKER_SCOPE = { name: "TackWorkerScope", code: "TACK_WORKER_SCOPE" };
const WORKER_CONFINED = { name: "TackWorkerConfined", code: "TACK_WORKER_CONFINED" };

/** An in-process child session: DSH stamps `origin: "subagent"` on every subagent child's header. */
function isWorkerSession(agent: NonNullable<HookedCall["agent"]>): boolean {
  return agent.session.header?.origin === "subagent";
}

/** The delegation a worker session is bound to: its own (it inherits its starter's), else its parent's. */
function boundDelegation(ledger: WorkerLedger, agent: NonNullable<HookedCall["agent"]>): string | undefined {
  const own = ledger.current(String(agent.session.id));
  if (own !== undefined) return own;
  const parent = agent.session.header?.parentSession;
  return typeof parent === "string" ? ledger.current(parent) : undefined;
}

function textOf(blocks: SubagentEndInfo["lastAssistantMessage"]): string | undefined {
  const text = (blocks ?? []).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n").trim();
  return text === "" ? undefined : text;
}

/** `load` once; a failure is retried on the next call. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** The dry_run gate as the worker hooks ask it: the delegation's record, read when a worker would execute. */
export interface DryRunGate {
  record(delegation: string): Promise<DelegationRecord>;
}

/**
 * Four refusals and one settlement. A session bound to a delegation starts
 * workers through `research_dispatch` only: a native `subagent*` call there
 * is refused. A worker session (an in-process child) keeps to a worker's
 * research tools: it reads and runs compute on its parent's delegation, and
 * reports; it does not record or decide. With a `dryRun` gate, a worker
 * session bound to a delegation executes nothing (`molab_start_execution`,
 * `molab run …` without `--dry-run`) before a person approved a dry run on
 * that delegation. With a `confinement`, it works inside the served root: a
 * file tool or shell argument that reaches another workspace is refused.
 * When a child ends, DSH's `subagent/end` closes its attempt in the ledger.
 *
 * `subagent/end` carries the stop reason and final text only: no cost or
 * turn count, so `worker_usd` is charged only by a provider that reports one.
 */
export function hookWorkers(ctx: WorkerHookContext, ledger: WorkerLedger, confinement?: Confinement, dryRun?: DryRunGate): void {
  const root = confinement === undefined ? undefined : once(confinement.root);
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.agent === undefined) return next();
    const sessionId = String(exec.agent.session.id);
    const worker = isWorkerSession(exec.agent);
    if (worker && isResearchTool(exec.name) && !WORKER_TOOLS.has(exec.name)) {
      return { kind: "deny", reason: workerScopeRefusal(exec.name), info: WORKER_SCOPE };
    }
    if (isWorkerTool(exec.name)) {
      const delegation = ledger.current(sessionId);
      if (delegation !== undefined) return { kind: "deny", reason: dispatchRefusal(exec.name, delegation, worker), info: USE_DISPATCH };
    }
    if (worker && dryRun !== undefined) {
      const execution = executionOf(exec.name, exec.arguments);
      const delegation = execution === undefined ? undefined : boundDelegation(ledger, exec.agent);
      if (execution !== undefined && delegation !== undefined) {
        let open: boolean;
        try {
          open = dryRunOpen(await dryRun.record(delegation));
        } catch (error) {
          return { kind: "deny", reason: `Not run: delegation ${delegation} cannot be read from molab (${errorMessage(error)}), so whether its dry run was approved is unknown. Retry shortly.`, info: GATE_DRYRUN };
        }
        if (!open) return { kind: "deny", reason: dryRunRefusal(execution, delegation), info: GATE_DRYRUN };
      }
    }
    if (worker && confinement !== undefined && root !== undefined && boundDelegation(ledger, exec.agent) !== undefined) {
      let served: string;
      try {
        served = await root();
      } catch (error) {
        return { kind: "deny", reason: `Not run: the served workspace root cannot be read from molab (${errorMessage(error)}), and a worker works inside it only. Retry shortly.`, info: WORKER_CONFINED };
      }
      const outside = confinementProblem(exec.name, exec.arguments, served, confinement.allowed);
      if (outside !== undefined) return { kind: "deny", reason: confinedRefusal(exec.name, outside, served), info: WORKER_CONFINED };
    }
    return next();
  });

  ctx.on("subagent/end", async (info) => {
    const output = textOf(info.lastAssistantMessage);
    await ledger.ended({ subagentId: String(info.id), stopReason: info.stopReason, ...(output !== undefined && { output }) });
  });
}

// ── Gate trailer ─────────────────────────────────────────────────────────────

/** Tack's `tack run` command-line service (`@tack/plugins/headless-startup`); provided in a headless run only, never under `tack web`. */
const HEADLESS_SERVICE = "headlessStartup";

/** The plugin-context slice the trailer uses: the session log, and whether this is a headless run. */
export interface TrailerContext {
  on(event: "session/event", listener: (session: { readonly id: unknown }, event: { readonly type: string }) => void): () => void;
  get(name: string): unknown;
}

export interface GateTrailerHook {
  /** Print the trailer of every blocked delegation a session of this run worked on. */
  flush(): Promise<void>;
}

/**
 * `tack run` ends with the session's final answer: DSH's headless runner
 * prints it, then asks the launcher to exit, which Tack turns into the
 * tree's disposal. That disposal is the one point after the answer where
 * Tack code runs, so the trailer is printed from this hook's effect disposer
 * (`flush`; cordis awaits an async disposer, and Tack's shutdown gives the
 * tree five seconds). The delegations are those a session that ended a turn
 * was focused on, heard on `session/event` turn/end; the run is headless
 * when the `headlessStartup` service exists.
 */
export function hookGateTrailer(
  ctx: TrailerContext,
  ledger: Pick<WorkerLedger, "current">,
  store: Pick<DelegationStore, "get">,
  logger: { warn(message: string): void },
  write: (text: string) => void = (text) => void process.stdout.write(text),
): GateTrailerHook {
  const ended = new Set<string>();
  let headless = false;
  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    const delegation = ledger.current(String(session.id));
    if (delegation === undefined) return;
    ended.add(delegation);
    headless ||= ctx.get(HEADLESS_SERVICE) !== undefined;
  });
  return {
    async flush() {
      if (!headless) return;
      for (const path of ended) {
        try {
          const trailer = gateTrailer(path, (await store.get(path)).record);
          if (trailer !== undefined) write(renderTrailer(trailer));
        } catch (error) {
          logger.warn(`tack-research: the gate trailer of ${path} was not printed: ${errorMessage(error)}`);
        }
      }
    },
  };
}

// ── Workers port ─────────────────────────────────────────────────────────────

/** A text content block, as dsh-llm spells it. */
type TextBlock = { type: "text"; text: string };

/** The slice of DSH's SubagentRuntime (`ctx.subagents`) the port uses. */
export interface SubagentsService {
  list(): string[];
  getProvider(name: string): { readonly capabilities: { readonly outputSchema: boolean }; readonly inheritsParentContext: boolean; readonly prepareContinuable?: unknown; readonly start?: unknown } | undefined;
  startActivation(spec: {
    readonly provider: string;
    readonly label: string;
    readonly request: { readonly cwd: string; readonly prompt: TextBlock[]; readonly parent: Agent; readonly outputSchema?: Record<string, unknown> };
    readonly signal: AbortSignal;
    readonly delivery: "parent" | "caller";
  }): Promise<{ readonly childId: unknown; readonly result: Promise<{ readonly output: readonly { type: string; text?: string }[]; readonly structured?: unknown; readonly stopReason: string; readonly diagnostic?: string }> }>;
  sendMessage(sender: Agent, targetId: never, content: TextBlock[], options: { readonly signal: AbortSignal }): Promise<unknown>;
}

/** DSH's agent registry (`ctx.agents`): live agents by session id. */
export interface AgentRegistry {
  get(id: never): Agent | undefined;
}

const LABEL_CHARS = 80;

/**
 * The workers port over DSH's subagent service. A worker is a DSH activation
 * with parent delivery: DSH runs it and delivers its settlement to the
 * supervisor; the port only hands back the child id and the result. The
 * structured report is requested from a provider that can capture one
 * (spawn, fork, @tack/codex); Claude Code gets the contract in the brief.
 * In-process children (`start` absent, `prepareContinuable` present) join
 * the parent's composition, so they see the research session's tools.
 */
export function dshWorkers(subagents: SubagentsService, agents: () => AgentRegistry | undefined): WorkersPort {
  const parentOf = (sessionId: string | undefined): Agent => {
    const agent = sessionId === undefined ? undefined : agents()?.get(sessionId as never);
    if (agent === undefined) throw new Error("dispatching a worker needs a live supervising session (the agent registry does not know this session)");
    return agent;
  };
  return {
    kinds(): WorkerKind[] {
      return subagents.list().flatMap((name) => {
        const provider = subagents.getProvider(name);
        if (provider === undefined) return [];
        const inProcess = typeof provider.prepareContinuable === "function";
        return [{ name, structured: provider.capabilities.outputSchema, continuable: inProcess, inProcess }];
      });
    },
    async start(request: WorkerStartRequest) {
      const provider = subagents.getProvider(request.provider);
      if (provider === undefined) throw new Error(`no worker provider "${request.provider}"`);
      const outputSchema = provider.capabilities.outputSchema ? request.outputSchema : undefined;
      const activation = await subagents.startActivation({
        provider: request.provider,
        label: clip(request.label, LABEL_CHARS),
        request: { cwd: request.cwd, prompt: [{ type: "text", text: request.prompt }], parent: parentOf(request.parentSessionId), ...(outputSchema !== undefined && { outputSchema }) },
        signal: request.signal,
        delivery: "parent",
      });
      const result: Promise<WorkerOutcome> = activation.result.then((settled) => ({
        output: textOf(settled.output) ?? "",
        ...(settled.structured !== undefined && { structured: settled.structured }),
        stopReason: settled.stopReason,
        ...(settled.diagnostic !== undefined && { diagnostic: settled.diagnostic }),
      }));
      return { id: String(activation.childId), result };
    },
    async continue(childId, text, parentSessionId, signal) {
      await subagents.sendMessage(parentOf(parentSessionId), childId as never, [{ type: "text", text }], { signal });
    },
  };
}

// ── Waking ───────────────────────────────────────────────────────────────────

interface SessionController {
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: unknown }>;
  create(request: { cwd?: string }): Promise<{ sessionId: string }>;
}
interface Sessions {
  flush(session: Agent["session"]): Promise<boolean>;
}

/**
 * Wake a supervising session with a brief, the way DSH's scheduler delivers a
 * reminder: resolve (or resume) the session's agent, queue the brief as its
 * own turn, and wait for the session log to acknowledge it. A session that no
 * longer exists is replaced by a new one in `cwd`; the agent is replaceable,
 * the delegation is not. `focus` hears, before the brief is queued, that the
 * woken session works on the delegation.
 */
export function dshWaker(get: (name: string) => unknown, cwd: () => Promise<string>, focus?: (sessionId: string, delegation: string) => void): Waker {
  return {
    async wake(sessionId, text, summary, delegation) {
      const controller = get("sessionController") as SessionController | undefined;
      const sessions = get("sessions") as Sessions | undefined;
      if (controller === undefined || sessions === undefined) {
        throw new Error("waking a session needs the web composition (tack web --profile research)");
      }
      let resolved = sessionId === undefined ? undefined : await controller.resolveAgent(sessionId);
      if (resolved === undefined || "error" in resolved) {
        const created = await controller.create({ cwd: await cwd() });
        resolved = await controller.resolveAgent(created.sessionId);
        if ("error" in resolved) throw new Error(`cannot open a session to wake: ${String(resolved.error)}`);
      }
      const { agent } = resolved;
      focus?.(String(agent.session.id), delegation);
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "research-wake", form: "notice", summary: boundContextSummary(summary) } }) as never);
      if (!(await sessions.flush(agent.session))) throw new Error("the session log did not acknowledge the wake-up");
      return String(agent.session.id);
    },
  };
}
