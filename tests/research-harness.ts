/**
 * The research plugin wired the way `apply` wires it, over fakes: an
 * in-memory molab, a fake workers port, the real ledger and store, the tools
 * as DSH registers them (so session focus and the caller identity work), the
 * worker hooks, and the gate trailer of a headless run.
 *
 * The human gates are on, as in production. `open()` therefore also writes
 * a plan and has the caller approve it, the way a person would before any
 * worker is dispatched; `open({ plan: false })` leaves that to the test.
 */
import { expect } from "@rstest/core";
import { parseConfig } from "../packages/research/src/config.js";
import { confinementOf } from "../packages/research/src/confine.js";
import { approve as approveGate, type DelegationRecord, type Gate } from "../packages/research/src/delegation/model.js";
import { fileOnEnd } from "../packages/research/src/delegation/reports.js";
import { DelegationStore } from "../packages/research/src/delegation/store.js";
import { hookGateTrailer, hookWorkers, toDshTool } from "../packages/research/src/dsh/adapter.js";
import { researchTools } from "../packages/research/src/index.js";
import { MolabClient } from "../packages/research/src/molab/client.js";
import type { ResearchDeps, ToolSpec, ToolValue } from "../packages/research/src/tools/types.js";
import { WorkerLedger } from "../packages/research/src/workers.js";
import { type FakeMolab, startFakeMolab } from "./fake-molab.js";
import { fakeWorkers, type FakeWorkers } from "./fake-workers.js";

export const NOW = "2026-11-04T09:00:00.000Z";
export const ACTIONS = ["read", "create_run", "start_execution", "write_knowledge", "delegate_worker"];
/** The person behind the run, as `tack run` would record them (TACK_BY, else the OS user). */
export const CALLER = "roykid";

type Listener = (...args: unknown[]) => unknown;

/** A DSH tool call as the hooks see it; a worker session carries `origin: "subagent"` on its header. */
export interface Call {
  name: string;
  arguments: unknown;
  agent?: { session: { id: string; header?: { origin?: string; parentSession?: string } } };
}

export type Decision = { kind: "allow" } | { kind: "deny"; reason: string; info: { name: string; code: string } };

export interface OpenOver {
  budget?: Record<string, number>;
  actions?: string[];
  name?: string;
  acceptance?: string[];
  /** Write and approve a plan after opening (default true when the delegation may write knowledge). */
  plan?: boolean;
}

export interface ResearchHarness {
  molab: FakeMolab;
  deps: ResearchDeps;
  store: DelegationStore;
  ledger: WorkerLedger;
  workers: FakeWorkers;
  warnings: string[];
  /** Call a research tool as DSH would, from `session` (focus, caller identity and all). */
  call(name: string, args: Record<string, unknown>, session?: string): Promise<ToolValue>;
  /** `tools/pre-execute` for a call. */
  pre(call: Call): Promise<Decision>;
  /** DSH's `subagent/end` for a child. */
  end(child: string, stopReason?: string, text?: string): Promise<void>;
  /** DSH's `session/event` turn/end for a session. */
  turnEnd(session: string): Promise<void>;
  /** The headless run's gate trailer: what `flush` printed. */
  trailer: { flush(): Promise<void>; writes: string[] };
  /** Open a delegation from `session` (and, by default, plan and approve it); returns its path. */
  open(over?: OpenOver, session?: string): Promise<string>;
  /** Write a plan and have the caller approve it; returns the plan path. */
  plan(path: string, over?: Record<string, unknown>, session?: string): Promise<string>;
  /** A person approves a gate: through research_resume when the delegation is blocked, else on the record (as a web client would). */
  approve(path: string, gate: Gate, target: string, session?: string): Promise<void>;
  record(path: string): Promise<DelegationRecord>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** The `tack-research` row config, as `apply` receives it. */
  config?: Record<string, unknown>;
  /** Whether the `headlessStartup` service exists (a `tack run`); default true. */
  headless?: boolean;
}

/** How long an end waits for a start's filing in tests: a test settles the result first, or ends a worker whose result never comes. */
const REPORT_GRACE_MS = 100;

export async function researchHarness(root?: string, options: HarnessOptions = {}): Promise<ResearchHarness> {
  const molab = await startFakeMolab(root);
  const client = new MolabClient({ url: molab.url });
  const store = new DelegationStore(client, "tack");
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };
  const workers = fakeWorkers();
  const config = parseConfig(options.config ?? {});
  const ledger = new WorkerLedger(store, () => new Date(NOW), logger, { onEnded: fileOnEnd(() => deps), workers: workers.port, reportGraceMs: REPORT_GRACE_MS });
  let id = 0;
  // The worker-turn gate's `molab validate --new-only`: the fake's violations stand in for the new errors.
  const validate = async () => molab.violations;
  const deps: ResearchDeps = { config, molab: client, store, workers: workers.port, ledger, logger, validate, now: () => new Date(NOW), newId: () => String(++id) };
  const listeners = new Map<string, Listener>();
  const ctx = {
    on: (event: string, fn: Listener) => (listeners.set(event, fn), () => {}),
    get: (name: string) => (name === "headlessStartup" && options.headless !== false ? {} : undefined),
  };
  const dryRun = config.gates.dryRun ? { record: async (path: string) => (await store.get(path)).record } : undefined;
  hookWorkers(ctx as never, ledger, confinementOf(config.workers, () => client.root()), dryRun);
  const writes: string[] = [];
  const trailer = hookGateTrailer(ctx as never, ledger, store, logger, (text) => writes.push(text));
  const focus = (sessionId: string, delegation: string) => ledger.focus(sessionId, delegation);
  const tools = new Map(researchTools(deps).map((spec) => [spec.name, toDshTool(spec as ToolSpec<never>, { focus, caller: () => CALLER }) as { execute(args: unknown, exec: unknown): Promise<ToolValue> }]));
  const call: ResearchHarness["call"] = async (name, args, session = "S1") => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args, { signal: new AbortController().signal, agent: { session: { id: session } }, concludeTurn: () => {} });
  };
  const approve: ResearchHarness["approve"] = async (path, gate, target, session = "S1") => {
    const { record } = await store.get(path);
    if (record.state === "blocked") {
      await call("research_resume", { delegation: path, answers: `批准 ${target}`, approve: { gate, target } }, session);
      return;
    }
    await store.update(path, (current) => approveGate(current, { gate, target, by: CALLER, at: NOW }));
  };
  const plan: ResearchHarness["plan"] = async (path, over = {}, session = "S1") => {
    const name = (await store.get(path)).name;
    const value = await call(
      "research_plan",
      {
        delegation: path,
        name: `${name} plan`,
        hypothesis: "Blocky sequences conduct better",
        comparison: "ABAB vs AABB at fixed composition",
        fixed: ["T=400K"],
        varied: ["sequence"],
        runs: "3 seeds each",
        judgement: "sigma ratio > 1.2",
        products: ["sigma per run"],
        parameters: [],
        no_parameters_reason: "fixed by the brief",
        ...over,
      },
      session,
    );
    const planPath = (value.meta as { plan: { relPath: string } }).plan.relPath;
    await approve(path, "plan", planPath, session);
    return planPath;
  };
  return {
    molab,
    deps,
    store,
    ledger,
    workers,
    warnings,
    call,
    pre: async (exec) => {
      const allowed = { kind: "allow" } as const;
      const decision = (await listeners.get("tools/pre-execute")!(exec, async () => allowed)) as Decision;
      if (decision !== allowed) expect(decision.kind).toBe("deny");
      return decision;
    },
    end: async (child, stopReason = "completed", text) => {
      await listeners.get("subagent/end")!({ id: child, provider: "spawn", local: true, stopReason, ...(text !== undefined && { lastAssistantMessage: [{ type: "text", text }] }) });
    },
    turnEnd: async (session) => {
      await listeners.get("session/event")!({ id: session }, { type: "turn/end" });
    },
    trailer: { flush: () => trailer.flush(), writes },
    open: async (over = {}, session = "S1") => {
      const actions = over.actions ?? ACTIONS;
      const value = await call(
        "research_open",
        {
          name: over.name ?? "Sequence study",
          goal: "Does order matter?",
          actions,
          budget: over.budget ?? { worker_runs: 2 },
          acceptance: over.acceptance ?? ["trimer has 205 atoms"],
          stop_conditions: ["budget exhausted"],
        },
        session,
      );
      const path = (value.meta as { path: string }).path;
      if (over.plan !== false && actions.includes("write_knowledge")) await plan(path, {}, session);
      return path;
    },
    plan,
    approve,
    record: async (path) => (await store.get(path)).record,
    close: () => molab.close(),
  };
}

/** A report a well-behaved worker returns. */
export function sampleReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "done",
    summary: "Built the trimer and the 10-mer; both connect as e20 did.",
    checks: { "trimer has 205 atoms": { verdict: "pass", value: 205 }, "decamer has 674 atoms": { verdict: "pass", value: 674, note: "bridges 6-5 throughout" } },
    products: [{ path: "experiments/chain/scratch/trimer.pdb", kind: "structure", description: "the trimer" }],
    files_changed: ["experiments/chain/scratch/build.py"],
    workflow: "experiments/chain/workflow.py",
    protocol_deviations: [],
    capability_gaps: [],
    open_questions: [],
    tokens: "unavailable",
    ...over,
  };
}
