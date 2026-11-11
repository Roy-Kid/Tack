/**
 * `tack-research`: research supervision over a Molab scope.
 *
 * Binds to the node `molab serve` opened, keeps every delegation, plan,
 * brief, worker report, assessment, report and decision as Molab knowledge,
 * and wakes the supervising session when compute it waits on settles.
 * Workers run on DSH's subagent runtime: `research_dispatch` compiles the
 * brief, starts the worker through DSH, charges and records the attempt, and
 * files the worker's report when it settles (see `workers.ts`,
 * `delegation/reports.ts`). Tack holds no authoritative state: restart it and
 * the watcher reconciles from Molab.
 */
import { randomUUID } from "node:crypto";
import { parseConfig } from "./config.js";
import { mountResearchWeb, type ResearchWebContext } from "./dsh/web.js";
import { confinementOf } from "./confine.js";
import { fileOnEnd } from "./delegation/reports.js";
import { DelegationStore } from "./delegation/store.js";
import { type AgentRegistry, dshWaker, dshWorkers, hookGateTrailer, hookWorkers, type SubagentsService, toDshTool, type TrailerContext, type WorkerHookContext } from "./dsh/adapter.js";
import { MolabClient } from "./molab/client.js";
import { validateNewOnly } from "./molab/validate.js";
import { researchOpen, researchPause, researchResume, researchStatus, researchWait } from "./tools/delegation-tools.js";
import { researchDispatch } from "./tools/dispatch-tools.js";
import { researchAssess, researchDecide } from "./tools/knowledge-tools.js";
import { molabCancelExecution, molabCreateExperiment, molabCreateRun, molabDryRun, molabReadOutputs, molabStartExecution, researchContext } from "./tools/molab-tools.js";
import { researchPlan } from "./tools/plan-tool.js";
import type { ResearchDeps, ToolSpec } from "./tools/types.js";
import { researchAudit } from "./tools/audit-tool.js";
import { researchReport, researchRetract } from "./tools/report-tools.js";
import { researchReplay } from "./tools/replay-tool.js";
import { Watcher } from "./watcher.js";
import { WorkerLedger } from "./workers.js";

export const name = "tack-research";
const FIRST_TICK_DELAY_MS = 3_000;
export const inject = ["tools", "subagents"];

/** The parts of the plugin context `tack-research` uses. */
type ResearchContext = WorkerHookContext & Partial<ResearchWebContext> &
  TrailerContext & {
    tools: { register(definition: unknown): () => void };
    subagents: SubagentsService;
    effect(execute: () => () => void | Promise<void>, label?: string): void;
    logger: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void };
  };

/** Every research tool, in the order the supervisor meets them. */
export function researchTools(deps: ResearchDeps): ToolSpec<never>[] {
  return [
    researchContext(deps),
    researchReplay(deps),
    researchAudit(deps),
    researchOpen(deps),
    researchPlan(deps),
    researchDispatch(deps),
    molabDryRun(deps),
    molabCreateExperiment(deps),
    molabCreateRun(deps),
    molabStartExecution(deps),
    researchWait(deps),
    researchStatus(deps),
    molabReadOutputs(deps),
    researchAssess(deps),
    researchReport(deps),
    researchDecide(deps),
    researchResume(deps),
    researchRetract(deps),
    researchPause(deps),
    molabCancelExecution(deps),
  ] as ToolSpec<never>[];
}

export function apply(ctx: ResearchContext, rawConfig: unknown): void {
  const config = parseConfig(rawConfig);
  const token = process.env[config.molab.tokenEnv];
  const molab = new MolabClient({ url: config.molab.url, ...(token !== undefined && token !== "" && { token }) });
  const store = new DelegationStore(molab, config.createdBy);
  const logger = { warn: (message: string) => ctx.logger.warn(message) };
  const workers = dshWorkers(ctx.subagents, () => ctx.get("agents") as AgentRegistry | undefined);
  // A continued worker's report is filed from its final text when it ends; a worker that ends without one is asked once more.
  const ledger = new WorkerLedger(store, () => new Date(), logger, { onEnded: fileOnEnd(() => deps), workers });
  const deps: ResearchDeps = {
    config,
    molab,
    store,
    workers,
    ledger,
    logger,
    validate: async (signal) => validateNewOnly(await molab.root(signal), signal),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
  const focus = (sessionId: string, delegation: string) => ledger.focus(sessionId, delegation);
  if (ctx.inject !== undefined) mountResearchWeb(ctx as ResearchContext & ResearchWebContext, deps);
  // Gate dry_run in worker sessions: the hook reads the delegation when a worker would execute.
  const dryRun = config.gates.dryRun ? { record: async (path: string) => (await store.get(path)).record } : undefined;
  hookWorkers(ctx, ledger, confinementOf(config.workers, () => molab.root()), dryRun);
  // A headless run prints the TACK-GATE trailer after its answer: at disposal, the one point after the answer where Tack runs.
  const trailer = hookGateTrailer(ctx, ledger, store, logger);
  ctx.effect(() => () => trailer.flush(), "tack-research: gate trailer");
  const disposers = researchTools(deps).map((spec) => ctx.tools.register(toDshTool(spec, { focus })));
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, "tack-research: tools");

  const watcher = new Watcher(molab, store, dshWaker((service) => ctx.get(service), () => molab.root(), focus), {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
  });
  ctx.effect(() => {
    // The first pass reconciles whatever settled while Tack was down. It waits
    // a moment so short host-plane boots (`tack model`, `tack doctor`) end
    // before it would reach molab.
    const first = setTimeout(() => void watcher.tick(), FIRST_TICK_DELAY_MS);
    const timer = setInterval(() => void watcher.tick(), config.pollSeconds * 1000);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, "tack-research: watcher");
}
