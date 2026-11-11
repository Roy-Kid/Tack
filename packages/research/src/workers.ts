/**
 * Worker runs held to the delegation a supervising session works on.
 *
 * Workers run on DSH's subagent runtime; Tack starts them through
 * `research_dispatch` only. This ledger is what makes a start count: the
 * dispatch tool holds one `worker_runs` while a start is in flight, charges
 * it and records the attempt once the child exists, and the child's end
 * (DSH's `subagent/end`) closes the attempt.
 *
 * Which delegation a session works on: the one it last opened (research_open)
 * or named in a successful research tool call (`delegation` argument), or the
 * one a wake-up was delivered for. A worker inherits its starter's delegation,
 * so its own molab calls are bound to it. A session with no delegation is
 * left alone. The binding is in memory: after Tack restarts, a session is
 * bound again by its next research call or wake-up.
 *
 * Runtime-neutral: the DSH hooks that feed it live in `dsh/adapter.ts`.
 */
import type { GatesConfig } from "./config.js";
import { type Attempt, budgetLeft, type DelegationRecord, gatePending, isApproved, noteAttempt, recordAttempt, reopenAttempt, requireActive, requireBudget, settleAttempt, spend } from "./delegation/model.js";
import type { DelegationStore } from "./delegation/store.js";
import { clip, errorMessage } from "./text.js";
import type { WorkersPort } from "./tools/types.js";

/** The tools that start a worker: DSH's subagent tools, one per provider. */
const WORKER_TOOL = /^subagent(_|$)/;
/** The research and molab tools. */
const RESEARCH_TOOL = /^(research|molab)_/;
const TASK_CHARS = 200;
const SUMMARY_CHARS = 500;
/** What the attempt's check says once its worker was asked for the report again. */
export const RE_REQUEST_NOTE = "report re-requested once";
/** How long a re-request may take to reach the worker. */
const RE_REQUEST_TIMEOUT_MS = 30_000;
/** How long an end waits for the filing of a start's result before the report counts as unknown. */
const REPORT_GRACE_MS = 15_000;

/**
 * What a continuable worker is told when it ended without a valid report.
 * DSH resumes a settled child without its output schema, so the report comes
 * back as text: the fenced block the continue path already files.
 */
export const REPORT_RE_REQUEST = [
  "Your report did not reach the supervisor. File it now and do nothing else: end this reply with exactly one fenced ```json block holding the report, with nothing after the block.",
  "Do not call structured_output; it is not available on a continued turn. The schema is the one in your brief (outcome, summary, checks, products, files_changed, workflow, protocol_deviations, capability_gaps, open_questions, next, tokens).",
  "Keep every string short: summary at most 400 characters, each check value at most 120 characters, at most 10 products. No prose before or after the block.",
].join(" ");

/** What the attempt's check starts with when the turn left the workspace invalid (see `delegation/reports.ts`). */
export const WORKSPACE_INVALID = "workspace invalid";

/**
 * What a worker is told when its report was not accepted. A turn that left
 * the workspace invalid hears the errors and fixes them first; any other
 * refusal is the plain re-request.
 */
export function reRequestText(check: string | null | undefined): string {
  if (check === undefined || check === null || !check.startsWith(WORKSPACE_INVALID)) return REPORT_RE_REQUEST;
  return [
    `Your turn was not accepted: ${check}.`,
    "Fix every one of these errors first (run `molab validate --new-only` in the workspace to see them all: move or delete stray files, keep logs and per-task evidence in out/, register only final products), and run the check again until it reports no error.",
    "Then file your report: end this reply with exactly one fenced ```json block holding the report, with nothing after the block. Do not call structured_output; the schema is the one in your brief.",
  ].join(" ");
}

export function isWorkerTool(name: string): boolean {
  return WORKER_TOOL.test(name);
}

export function isResearchTool(name: string): boolean {
  return RESEARCH_TOOL.test(name);
}

/** The research tools a worker session may call: read, and run compute on the parent's delegation. */
export const WORKER_TOOLS: ReadonlySet<string> = new Set([
  "research_context",
  "research_audit",
  "molab_create_experiment",
  "molab_create_run",
  "molab_start_execution",
  "molab_read_outputs",
  "molab_dry_run",
]);

/** Why a worker session may not call a research tool outside {@link WORKER_TOOLS}. */
export function workerScopeRefusal(tool: string): string {
  return (
    `Not run: this session is a worker, and ${tool} belongs to the supervisor, who records and decides from your report. ` +
    "Do the task; put what you found, what you could not do and every open question in your final report (outcome, checks, products, protocol_deviations, capability_gaps, open_questions)."
  );
}

/** Why a native subagent tool is refused in a session bound to a delegation. */
export function dispatchRefusal(tool: string, delegation: string, worker: boolean): string {
  if (worker) {
    return `Not started: this session is a worker of delegation ${delegation} and does not start workers. Do the task yourself; what you cannot do goes in your report.`;
  }
  return (
    `Not started: this session works on delegation ${delegation}, so workers start through research_dispatch, which compiles the brief, charges the delegation's budget, records the attempt and links the worker's report. ` +
    `${tool} would bypass all of that.`
  );
}

export interface LedgerLogger {
  warn(message: string): void;
}

/** A worker start that happened: what to record on the delegation. */
export interface WorkerStart {
  delegation: string;
  /** The runtime's child id (the worker's session id). */
  subagentId: string;
  /** The attempt id, when it differs from the child id (a continuation round of the same child). */
  attemptId?: string;
  /** The worker's provider name. */
  worker: string;
  task: string;
  brief?: string;
  brief_digest?: string;
  /** Link the report from the child's final text when it ends (a continuation has no result promise). */
  linkOnEnd?: boolean;
  /** The supervising session that started it: a re-request for its report is sent on its behalf. */
  parentSessionId?: string;
  /** Whether the report filed from the start's result was linked (true), refused (false) or not filed (undefined). */
  reported?: Promise<boolean | undefined>;
  /** A change the start folds into its one Delegation write (the brief's write-log entry). */
  remember?: (record: DelegationRecord) => DelegationRecord;
}

/** How a worker ended, as far as the runtime reports it. */
export interface WorkerEnd {
  subagentId: string;
  stopReason: string;
  /** The worker's final text, when it produced one. */
  output?: string;
  costUsd?: number;
  turns?: number;
}

/** Called when a worker whose start asked for it ends: link its report from its final text; true when a valid report was linked. */
export type EndedHook = (delegation: string, attemptId: string, end: WorkerEnd) => Promise<boolean>;

export interface LedgerOptions {
  onEnded?: EndedHook;
  /** The runtime's port: a continuable worker that ended without a valid report is asked for it once. */
  workers?: Pick<WorkersPort, "kinds" | "continue">;
  reportGraceMs?: number;
}

/**
 * Why the delegation at `path` cannot start one more worker with `reserved`
 * starts already let through; undefined when it can. With `gates`, the plan
 * gate applies: no worker before a person approved the current plan.
 */
export function workerRefusal(record: DelegationRecord, path: string, reserved = 0, gates?: GatesConfig): string | undefined {
  try {
    requireActive(record);
  } catch (error) {
    return errorMessage(error);
  }
  if (!record.actions.includes("delegate_worker")) {
    return (
      `it was not granted the "delegate_worker" action (granted: ${record.actions.join(", ")}). ` +
      `Do the step yourself, or ask the person to grant it with research_decide(decision: "ask_human"); they add it with \`tack research amend ${path} --add-action delegate_worker --reason "..."\`.`
    );
  }
  if (gates?.plan === true) {
    const plan = record.current_plan;
    if (plan === undefined || plan === null) return "no plan is recorded yet: write one with research_plan; a person approves it before any worker is dispatched.";
    if (!isApproved(record, "plan", plan)) return gatePending("plan", plan);
  }
  const usdLeft = budgetLeft(record).worker_usd;
  if (usdLeft !== undefined && usdLeft <= 1e-9) {
    return (
      `budget exhausted: worker_usd has ${Math.max(usdLeft, 0)} left. ` +
      `Ask the person for more with research_decide(decision: "ask_human"); they widen it with \`tack research amend ${path} --budget worker_usd=<limit> --reason "..."\`.`
    );
  }
  try {
    requireBudget(record, { worker_runs: 1 + reserved });
  } catch (error) {
    const pending = reserved > 0 ? `${reserved} worker start${reserved === 1 ? " is" : "s are"} already in flight; ` : "";
    return `${pending}${errorMessage(error)} The command: \`tack research amend ${path} --budget worker_runs=<limit> --reason "..."\`.`;
  }
  return undefined;
}

interface LiveWorker {
  delegation: string;
  attemptId: string;
  child: string;
  worker: string;
  parentSessionId?: string;
  linkOnEnd: boolean;
  recorded: Promise<boolean>;
  reported?: Promise<boolean | undefined>;
  /** The worker was already asked once more for its report. */
  reRequested: boolean;
}

const delay = (ms: number): Promise<undefined> => new Promise((done) => setTimeout(() => done(undefined), ms).unref());

export class WorkerLedger {
  /** Delegation path by session id. */
  readonly #focus = new Map<string, string>();
  /** Starts let through and not yet charged: the delegation each will be charged to, by call. */
  readonly #reserved = new Map<object, string>();
  /** Recorded attempts by child id. */
  readonly #live = new Map<string, LiveWorker>();
  readonly #onEnded: EndedHook | undefined;
  readonly #workers: LedgerOptions["workers"];
  readonly #reportGraceMs: number;

  constructor(
    private readonly store: DelegationStore,
    private readonly now: () => Date,
    private readonly logger: LedgerLogger,
    options: LedgerOptions = {},
  ) {
    this.#onEnded = options.onEnded;
    this.#workers = options.workers;
    this.#reportGraceMs = options.reportGraceMs ?? REPORT_GRACE_MS;
  }

  /** The session now works on `delegation`. */
  focus(sessionId: string, delegation: string): void {
    const path = delegation.trim();
    if (path !== "") this.#focus.set(sessionId, path);
  }

  current(sessionId: string): string | undefined {
    return this.#focus.get(sessionId);
  }

  /** Every delegation a session of this process works on. */
  focused(): string[] {
    return [...new Set(this.#focus.values())];
  }

  /** Starts admitted against `delegation` and not yet charged. */
  inFlight(delegation: string): number {
    return [...this.#reserved.values()].filter((path) => path === delegation).length;
  }

  /** Hold one `worker_runs` of `delegation` for the start identified by `call`, until it is charged or released. */
  hold(delegation: string, call: object): void {
    this.#reserved.set(call, delegation);
  }

  /** A held start did not happen. */
  release(call: object): void {
    this.#reserved.delete(call);
  }

  /**
   * A worker started: charge one run and record its attempt. The worker's
   * session inherits the delegation, so its molab calls are bound to it.
   */
  async started(call: object, start: WorkerStart): Promise<Attempt> {
    const attemptId = start.attemptId ?? start.subagentId;
    this.focus(start.subagentId, start.delegation);
    const attempt: Attempt = {
      id: attemptId,
      worker: start.worker,
      task: clip(start.task.trim(), TASK_CHARS),
      status: "running",
      summary: "",
      files_changed: [],
      started_at: this.now().toISOString(),
      ...(start.brief !== undefined && { brief: start.brief }),
      ...(start.brief_digest !== undefined && { brief_digest: start.brief_digest }),
    };
    const recorded = this.store
      .update(start.delegation, (record) => spend(recordAttempt(start.remember?.(record) ?? record, attempt), { worker_runs: 1 }))
      .then(
        () => true,
        (error: unknown) => {
          this.logger.warn(`tack-research: worker ${start.subagentId} (${start.worker}) started but was not charged to ${start.delegation}: ${errorMessage(error)}`);
          return false;
        },
      )
      .finally(() => this.#reserved.delete(call));
    this.#live.set(start.subagentId, {
      delegation: start.delegation,
      attemptId,
      child: start.subagentId,
      worker: start.worker,
      ...(start.parentSessionId !== undefined && { parentSessionId: start.parentSessionId }),
      linkOnEnd: start.linkOnEnd === true,
      recorded,
      ...(start.reported !== undefined && { reported: start.reported }),
      reRequested: false,
    });
    await recorded;
    return attempt;
  }

  /**
   * A worker ended: close its attempt and charge its cost when the runtime
   * reports one. A continuable worker that left no valid report (an error
   * stop, no report, one that does not parse) is asked for it once more; the
   * attempt is open again until that reply ends, and the reply's end files
   * it through the continue path. A second end without a report settles it
   * as unreported.
   */
  async ended(end: WorkerEnd): Promise<void> {
    const live = this.#live.get(end.subagentId);
    if (live === undefined) return;
    this.#live.delete(end.subagentId);
    if (!(await live.recorded)) return;
    await this.#settle(live, end);
    const linked = await this.#linked(live, end);
    if (linked === true) return;
    if (live.reRequested) {
      await this.#annotate(live, RE_REQUEST_NOTE);
      return;
    }
    // A completed end whose filing is still on its way says nothing against the report.
    if (end.stopReason === "completed" && linked === undefined) return;
    if (this.#continuable(live.worker)) await this.#reRequest(live);
  }

  async #settle(live: LiveWorker, end: WorkerEnd): Promise<void> {
    const cost = end.costUsd !== undefined && end.costUsd >= 0 ? end.costUsd : undefined;
    try {
      await this.store.update(live.delegation, (record) => {
        const settled = settleAttempt(record, live.attemptId, {
          status: end.stopReason,
          summary: clip(end.output ?? "", SUMMARY_CHARS),
          ended_at: this.now().toISOString(),
          ...(cost !== undefined && { cost_usd: cost }),
          ...(end.turns !== undefined && { turns: end.turns }),
        });
        return cost === undefined ? settled : spend(settled, { worker_usd: cost });
      });
    } catch (error) {
      this.logger.warn(`tack-research: worker ${live.child} ended (${end.stopReason}) but its attempt on ${live.delegation} was not closed: ${errorMessage(error)}`);
    }
  }

  /** Whether a valid report was linked to the attempt: filed from the end's text, or from the start's result; undefined when unknown. */
  async #linked(live: LiveWorker, end: WorkerEnd): Promise<boolean | undefined> {
    if (live.linkOnEnd) {
      if (this.#onEnded === undefined) return undefined;
      try {
        return await this.#onEnded(live.delegation, live.attemptId, end);
      } catch (error) {
        this.logger.warn(`tack-research: worker ${live.child} ended but its report was not linked to ${live.attemptId} on ${live.delegation}: ${errorMessage(error)}`);
        return undefined;
      }
    }
    return live.reported === undefined ? undefined : Promise.race([live.reported, delay(this.#reportGraceMs)]);
  }

  #continuable(worker: string): boolean {
    return this.#workers?.continue !== undefined && this.#workers.kinds().some((kind) => kind.name === worker && kind.continuable);
  }

  /** Ask the worker for its report; the attempt is open again until the reply ends. */
  async #reRequest(live: LiveWorker): Promise<void> {
    let check: string | null | undefined;
    try {
      check = (await this.store.get(live.delegation)).record.attempts.find((attempt) => attempt.id === live.attemptId)?.check;
    } catch (error) {
      this.logger.warn(`tack-research: attempt ${live.attemptId} on ${live.delegation} could not be read before re-requesting its report: ${errorMessage(error)}`);
    }
    try {
      await this.#workers!.continue!(live.child, reRequestText(check), live.parentSessionId, AbortSignal.timeout(RE_REQUEST_TIMEOUT_MS));
    } catch (error) {
      this.logger.warn(`tack-research: worker ${live.child} ended without a report and could not be asked for it (attempt ${live.attemptId} on ${live.delegation}): ${errorMessage(error)}`);
      return;
    }
    this.#live.set(live.child, { ...live, linkOnEnd: true, recorded: Promise.resolve(true), reported: undefined, reRequested: true });
    try {
      await this.store.update(live.delegation, (record) => reopenAttempt(record, live.attemptId, RE_REQUEST_NOTE));
    } catch (error) {
      this.logger.warn(`tack-research: worker ${live.child} was asked for its report but attempt ${live.attemptId} on ${live.delegation} was not reopened: ${errorMessage(error)}`);
    }
  }

  async #annotate(live: LiveWorker, note: string): Promise<void> {
    try {
      await this.store.update(live.delegation, (record) => noteAttempt(record, live.attemptId, note));
    } catch (error) {
      this.logger.warn(`tack-research: attempt ${live.attemptId} on ${live.delegation} was not annotated "${note}": ${errorMessage(error)}`);
    }
  }
}
