/**
 * The Delegation record — Tack's mirror of molab's
 * `molab.knowledge.delegation.DelegationRecord` — and the pure transitions on
 * it. Molab validates every write again; this mirror lets Tack fail fast and
 * compute the next record without touching disk.
 *
 * Every transition returns a new record. Nothing here mutates its input.
 */
import { z } from "zod";

export const ACTIONS = [
  "read",
  "create_experiment",
  "create_run",
  "start_execution",
  "cancel_execution",
  "write_knowledge",
  "delegate_worker",
] as const;
export type Action = (typeof ACTIONS)[number];

const Budget = z
  .object({
    worker_usd: z.number().min(0).nullish(),
    worker_runs: z.number().int().min(0).nullish(),
    executions: z.number().int().min(0).nullish(),
    wall_hours: z.number().min(0).nullish(),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;
export type BudgetKey = keyof Budget;
export const BUDGET_KEYS: readonly BudgetKey[] = ["worker_usd", "worker_runs", "executions", "wall_hours"];

const Wait = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    project: z.string().nullish(),
    kind: z.literal("execution").default("execution"),
    request_key: z.string().nullish(),
    on_resolve: z.string().default(""),
    next_check_at: z.string().nullish(),
    deadline: z.string().nullish(),
    state: z.enum(["pending", "resolved", "expired"]).default("pending"),
    outcome: z.string().nullish(),
  })
  .strict();
export type Wait = z.infer<typeof Wait>;

const TokenCount = z.number().int().min(0);
/** A worker's token usage, or `unavailable` when its provider does not report one. */
export const Tokens = z.union([
  z.literal("unavailable"),
  z
    .object({
      input: TokenCount,
      output: TokenCount,
      cache_read: TokenCount.nullish(),
      cache_write: TokenCount.nullish(),
      reasoning: TokenCount.nullish(),
    })
    .strict(),
]);
export type Tokens = z.infer<typeof Tokens>;

/** A sha256 digest as molab validates it: 64 lowercase hex characters. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a sha256 digest is 64 lowercase hex characters");

const Attempt = z
  .object({
    id: z.string().min(1),
    worker: z.string().min(1),
    task: z.string().default(""),
    status: z.string().default(""),
    summary: z.string().default(""),
    cost_usd: z.number().min(0).nullish(),
    turns: z.number().int().min(0).nullish(),
    files_changed: z.array(z.string()).default([]),
    check: z.string().nullish(),
    started_at: z.string().nullish(),
    ended_at: z.string().nullish(),
    /** The brief Note the worker was given, and the digest of its body. */
    brief: z.string().nullish(),
    brief_digest: Sha256.nullish(),
    /** The worker's Report document, once linked. */
    report: z.string().nullish(),
    tokens: Tokens.nullish(),
  })
  .strict();
export type Attempt = z.infer<typeof Attempt>;

/**
 * One decision, kept on the Delegation itself: the delegation's decision log.
 * A decision is not a knowledge document of its own; molab's history of the
 * Delegation is the record of every revision.
 */
const Decision = z
  .object({
    at: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1),
    reason: z.string().min(1),
    evidence: z.array(z.string()).default([]),
    next: z.string().nullish(),
    questions: z.array(z.string()).default([]),
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

const Answer = z.object({ path: z.string().min(1), by: z.string().min(1), text: z.string() }).strict();
export type Answer = z.infer<typeof Answer>;

/** The checkpoints a person signs off, in the order a delegation meets them. */
export const GATES = ["parameters", "plan", "dry_run", "results"] as const;
export type Gate = (typeof GATES)[number];

/** A person's approval of one gate for one target (molab's `approvals` entry). */
const Approval = z
  .object({ gate: z.enum(GATES), target: z.string().min(1), by: z.string().min(1), at: z.string().min(1), note: z.string().nullish() })
  .strict();
export type Approval = z.infer<typeof Approval>;

/** A gate and what it is about: the plan path, the workflow or experiment path, the assessment Report path. */
export interface GateRef {
  gate: Gate;
  target: string;
}

export const STATES = ["open", "waiting", "blocked", "paused", "done", "stopped"] as const;
export type State = (typeof STATES)[number];

const Amendment = z
  .object({
    at: z.string().min(1),
    by: z.string().min(1),
    reason: z.string().min(1),
    changes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Amendment = z.infer<typeof Amendment>;

const Write = z.object({ key: z.string().min(1), path: z.string().min(1) }).strict();
export type Write = z.infer<typeof Write>;

export const DelegationRecord = z
  .object({
    kind: z.enum(["research", "capability"]).default("research"),
    goal: z.string().min(1),
    scope: z.string().min(1),
    actions: z.array(z.enum(ACTIONS)).default(["read"]),
    budget: Budget.default({}),
    spent: Budget.default({ worker_usd: 0, worker_runs: 0, executions: 0, wall_hours: 0 }),
    acceptance: z.array(z.string()).default([]),
    stop_conditions: z.array(z.string()).default([]),
    state: z.enum(STATES).default("open"),
    waits: z.array(Wait).default([]),
    attempts: z.array(Attempt).default([]),
    supervisor: z.record(z.string(), z.string()).default({}),
    current_plan: z.string().nullish(),
    questions: z.array(z.string()).default([]),
    amendments: z.array(Amendment).default([]),
    writes: z.array(Write).default([]),
    /** Every decision, oldest first; a brief carries the latest without a search. */
    decisions: z.array(Decision).default([]),
    /** What people answered (research_resume), clipped, newest last. */
    answers: z.array(Answer).default([]),
    /** What people approved (research_resume approve), oldest first. */
    approvals: z.array(Approval).default([]),
  })
  .strict()
  .superRefine((record, ctx) => {
    for (const [label, rows] of [
      ["wait", record.waits],
      ["attempt", record.attempts],
    ] as const) {
      const ids = rows.map((row) => row.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `delegation ${label} ids repeat: ${ids.join(", ")}` });
    }
  });
export type DelegationRecord = z.infer<typeof DelegationRecord>;

/** Frontmatter keys every document carries; never part of the record. */
const COMMON_KEYS = new Set(["class", "name", "created_by", "tags", "status"]);

/** Parse a record from molab (`GET …/doc/record`), ignoring common document keys. */
export function parseRecord(raw: Record<string, unknown>): DelegationRecord {
  const payload = Object.fromEntries(Object.entries(raw).filter(([key]) => !COMMON_KEYS.has(key)));
  const parsed = DelegationRecord.safeParse(payload);
  if (!parsed.success) throw new Error(`invalid Delegation record: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The JSON molab stores: nullish optionals dropped so the file stays minimal. */
export function toWire(record: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record, (_key, value: unknown) => (value === null ? undefined : value))) as Record<string, unknown>;
}

// ── Transitions ──────────────────────────────────────────────────────────────

export function transition(record: DelegationRecord, state: State): DelegationRecord {
  if ((record.state === "done" || record.state === "stopped") && state !== record.state) {
    throw new Error(`the delegation is ${record.state}; it does not move to ${state}`);
  }
  return { ...record, state };
}

export function openWait(record: DelegationRecord, wait: Omit<Wait, "state" | "kind" | "on_resolve"> & Partial<Pick<Wait, "on_resolve">>): DelegationRecord {
  if (record.waits.some((existing) => existing.id === wait.id)) throw new Error(`wait ${wait.id} already exists`);
  const next: Wait = { kind: "execution", on_resolve: "", ...wait, state: "pending" };
  return { ...record, waits: [...record.waits, next], state: record.state === "open" ? "waiting" : record.state };
}

/** Settle one wait. The delegation leaves `waiting` once no wait is pending. */
export function resolveWait(record: DelegationRecord, id: string, outcome: string, state: "resolved" | "expired" = "resolved"): DelegationRecord {
  if (!record.waits.some((wait) => wait.id === id)) throw new Error(`no wait ${id}`);
  const waits = record.waits.map((wait) => (wait.id === id ? { ...wait, state, outcome } : wait));
  const stillWaiting = waits.some((wait) => wait.state === "pending");
  return { ...record, waits, state: record.state === "waiting" && !stillWaiting ? "open" : record.state };
}

export function pendingWaits(record: DelegationRecord): Wait[] {
  return record.waits.filter((wait) => wait.state === "pending");
}

export function recordAttempt(record: DelegationRecord, attempt: Attempt): DelegationRecord {
  if (record.attempts.some((existing) => existing.id === attempt.id)) throw new Error(`attempt ${attempt.id} already exists`);
  return { ...record, attempts: [...record.attempts, attempt] };
}

/** Close an attempt with its outcome; an attempt already closed keeps its first outcome. */
export function settleAttempt(
  record: DelegationRecord,
  id: string,
  outcome: Pick<Attempt, "status" | "summary" | "ended_at"> & Partial<Pick<Attempt, "cost_usd" | "turns" | "tokens">>,
): DelegationRecord {
  const attempt = record.attempts.find((existing) => existing.id === id);
  if (attempt === undefined) throw new Error(`no attempt ${id}`);
  if (attempt.ended_at !== undefined && attempt.ended_at !== null) return record;
  return { ...record, attempts: record.attempts.map((existing) => (existing.id === id ? { ...existing, ...outcome } : existing)) };
}

function updateAttempt(record: DelegationRecord, id: string, change: (attempt: Attempt) => Attempt): DelegationRecord {
  if (!record.attempts.some((existing) => existing.id === id)) throw new Error(`no attempt ${id}`);
  return { ...record, attempts: record.attempts.map((existing) => (existing.id === id ? change(existing) : existing)) };
}

/** Add `note` to the attempt's check (what the supervisor reads about its report). */
export function noteAttempt(record: DelegationRecord, id: string, note: string): DelegationRecord {
  return updateAttempt(record, id, (attempt) => ({ ...attempt, check: attempt.check ? `${attempt.check}; ${note}` : note }));
}

/**
 * Open a settled attempt again: its worker was asked for more (a report that
 * did not come), so the next end is the one that settles it. `note` joins the
 * attempt's check so the record says why.
 */
export function reopenAttempt(record: DelegationRecord, id: string, note: string): DelegationRecord {
  return updateAttempt(noteAttempt(record, id, note), id, (attempt) => ({ ...attempt, status: "running", ended_at: undefined }));
}

/** Record the brief an attempt's worker was given. */
export function setBrief(record: DelegationRecord, id: string, brief: { path: string; digest: string }): DelegationRecord {
  return updateAttempt(record, id, (attempt) => ({ ...attempt, brief: brief.path, brief_digest: brief.digest }));
}

/**
 * Link a worker's Report to its attempt, or record the check that stands in
 * for a report that is missing or invalid. A report once linked stays linked;
 * a later check does not unlink it.
 */
export function linkReport(
  record: DelegationRecord,
  id: string,
  link: { report?: string; check?: string; summary?: string; tokens?: Tokens; files_changed?: readonly string[] },
): DelegationRecord {
  return updateAttempt(record, id, (attempt) => ({
    ...attempt,
    report: attempt.report ?? link.report,
    check: link.check,
    ...(link.summary !== undefined && { summary: link.summary }),
    ...(link.tokens !== undefined && { tokens: link.tokens }),
    ...(link.files_changed !== undefined && { files_changed: [...new Set([...attempt.files_changed, ...link.files_changed])] }),
  }));
}

const sameDecision = (a: Decision, b: Omit<Decision, "at">): boolean =>
  a.kind === b.kind && a.name === b.name && a.reason === b.reason && (a.next ?? undefined) === (b.next ?? undefined) && JSON.stringify(a.evidence) === JSON.stringify(b.evidence) && JSON.stringify(a.questions) === JSON.stringify(b.questions);

/** Append a decision to the log; a retry of the latest one (same content) changes nothing. */
export function recordDecision(record: DelegationRecord, decision: Decision): DelegationRecord {
  const parsed = Decision.safeParse(decision);
  if (!parsed.success) throw new Error(`invalid decision: ${z.prettifyError(parsed.error)}`);
  const latest = record.decisions.at(-1);
  if (latest !== undefined && sameDecision(latest, parsed.data)) return record;
  return { ...record, decisions: [...record.decisions, parsed.data] };
}

/** The latest decision, if any. */
export function lastDecision(record: DelegationRecord): Decision | undefined {
  return record.decisions.at(-1);
}

/** Remember what a person answered. */
export function recordAnswer(record: DelegationRecord, answer: Answer): DelegationRecord {
  return { ...record, answers: [...record.answers, answer] };
}

/** Add amounts to `spent`. */
export function spend(record: DelegationRecord, amounts: Partial<Record<BudgetKey, number>>): DelegationRecord {
  const spent: Budget = { ...record.spent };
  for (const key of BUDGET_KEYS) {
    const amount = amounts[key];
    if (amount === undefined) continue;
    if (amount < 0) throw new Error(`cannot spend a negative ${key}`);
    spent[key] = (spent[key] ?? 0) + amount;
  }
  return { ...record, spent };
}

/** What is left of each limited budget line; unlimited lines are absent. */
export function budgetLeft(record: DelegationRecord): Partial<Record<BudgetKey, number>> {
  const left: Partial<Record<BudgetKey, number>> = {};
  for (const key of BUDGET_KEYS) {
    const limit = record.budget[key];
    if (limit === null || limit === undefined) continue;
    left[key] = limit - (record.spent[key] ?? 0);
  }
  return left;
}

/** Refuse a step that would take a budget line past its limit. */
export function requireBudget(record: DelegationRecord, amounts: Partial<Record<BudgetKey, number>>): void {
  const left = budgetLeft(record);
  for (const key of BUDGET_KEYS) {
    const amount = amounts[key];
    const remaining = left[key];
    if (amount === undefined || remaining === undefined) continue;
    if (amount > remaining + 1e-9) {
      throw new Error(
        `budget exhausted: ${key} has ${Math.max(remaining, 0)} left, this step needs ${amount}. Ask the person for more with research_decide(decision: "ask_human"); they amend it with \`tack research amend\`.`,
      );
    }
  }
}

/** The delegation can take a new step (not finished, not paused, not waiting on a person). */
export function requireActive(record: DelegationRecord): void {
  if (record.state === "done" || record.state === "stopped") {
    throw new Error(
      `the delegation is ${record.state}: closing it (research_decide conclude or stop) ended its writes, so every report, capability gap and finding must be recorded before closing. Do not write around this in the shell; for further work open a new delegation with research_open.`,
    );
  }
  if (record.state === "paused") throw new Error("the delegation is paused; resume it before taking a step");
  if (record.state === "blocked") {
    throw new Error(`the delegation is blocked on a person: ${record.questions.join(" | ") || "(no question recorded)"}. Resume it with research_resume once they answer.`);
  }
}

/**
 * Wait on a person: record the questions; the delegation takes no step until
 * resumed. With `gate`, the first question carries the gate marker so the
 * gate can be read back ({@link pendingGate}): molab's Delegation record has
 * no field for it.
 */
export function block(record: DelegationRecord, questions: readonly string[], gate?: GateRef): DelegationRecord {
  if (questions.length === 0) throw new Error("blocking on a person needs the questions they must answer");
  return { ...transition(record, "blocked"), questions: gate === undefined ? [...questions] : markGate(gate, questions) };
}

// ── Human gates ──────────────────────────────────────────────────────────────

/** The marker a blocking question carries: `[gate:plan target:<path>]`. */
const GATE_MARKER = /^\[gate:(parameters|plan|dry_run|results) target:(\S+)\]\s*/;

function gateMarker(ref: GateRef): string {
  if (!GATES.includes(ref.gate)) throw new Error(`unknown gate "${String(ref.gate)}"; one of ${GATES.join(", ")}`);
  if (ref.target.trim() === "" || /\s/.test(ref.target)) throw new Error("a gate target is one path or ref, without spaces");
  return `[gate:${ref.gate} target:${ref.target}]`;
}

/** The questions with the gate marked on the first one (a marker already there is replaced). */
export function markGate(ref: GateRef, questions: readonly string[]): string[] {
  const [first, ...rest] = questions;
  if (first === undefined) throw new Error("a gate question needs the question the person must answer");
  return [`${gateMarker(ref)} ${first.replace(GATE_MARKER, "")}`, ...rest];
}

/** The gate a question carries and the question without its marker; undefined for a plain question. */
export function parseGate(question: string): { ref: GateRef; question: string } | undefined {
  const match = GATE_MARKER.exec(question);
  if (match === null) return undefined;
  return { ref: { gate: match[1] as Gate, target: match[2]! }, question: question.slice(match[0].length) };
}

/** The gate the delegation's open questions wait on, when they carry one. */
export function pendingGate(record: DelegationRecord): GateRef | undefined {
  for (const question of record.questions) {
    const parsed = parseGate(question);
    if (parsed !== undefined) return parsed.ref;
  }
  return undefined;
}

/** A person approved `gate` for `target`; every approval is kept. */
export function approve(record: DelegationRecord, approval: Approval): DelegationRecord {
  const parsed = Approval.safeParse(approval);
  if (!parsed.success) throw new Error(`invalid approval: ${z.prettifyError(parsed.error)}`);
  return { ...record, approvals: [...record.approvals, parsed.data] };
}

/** Drop every approval of `gate` for `target`: what was approved changed, so it is approved again or not at all. */
export function revoke(record: DelegationRecord, gate: Gate, target: string): DelegationRecord {
  const kept = record.approvals.filter((approval) => !(approval.gate === gate && approval.target === target));
  return kept.length === record.approvals.length ? record : { ...record, approvals: kept };
}

export function isApproved(record: DelegationRecord, gate: Gate, target: string): boolean {
  return record.approvals.some((approval) => approval.gate === gate && approval.target === target);
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * The latest approval of `gate` that covers `path`: for the path itself, a
 * directory above it, or a path under it. An approved dry run covers its
 * workflow and the experiment it lives in, whichever the person named.
 */
export function coveringApproval(record: DelegationRecord, gate: Gate, path: string): Approval | undefined {
  return [...record.approvals].reverse().find((approval) => approval.gate === gate && (within(path, approval.target) || within(approval.target, path)));
}

/** Why a step cannot be taken before a person approves `gate` for `target`. */
export function gatePending(gate: Gate, target: string): string {
  return (
    `the ${gate} gate is pending for ${target}: a person must approve it before this step. ` +
    `Ask with research_decide(decision: "ask_human", gate: {gate: "${gate}", target: "${target}"}, questions: [...]) and end your turn; ` +
    `the answer arrives in the next round and is recorded with research_resume(approve: {gate: "${gate}", target: "${target}"}) only when they approved it. ` +
    "Never record an approval the person did not give."
  );
}

/** Refuse a step whose gate a person has not approved for this target. */
export function requireApproved(record: DelegationRecord, gate: Gate, target: string): void {
  if (!isApproved(record, gate, target)) throw new Error(gatePending(gate, target));
}

/** A person answered: clear the questions and take steps again. */
export function resume(record: DelegationRecord): DelegationRecord {
  if (record.state !== "blocked" && record.state !== "paused") throw new Error(`only a blocked or paused delegation resumes; this one is ${record.state}`);
  return { ...record, questions: [], state: pendingWaits(record).length > 0 ? "waiting" : "open" };
}

/** Record a change a person made to the delegation's terms. */
export function amend(record: DelegationRecord, amendment: Amendment, changes: Partial<Pick<DelegationRecord, "budget" | "actions" | "acceptance" | "stop_conditions">>): DelegationRecord {
  if (record.state === "done" || record.state === "stopped") throw new Error(`the delegation is ${record.state}; open a new one instead`);
  return { ...record, ...changes, amendments: [...record.amendments, amendment] };
}

/** The document an earlier write with this content key produced, if any. */
export function priorWrite(record: DelegationRecord, key: string): string | undefined {
  return record.writes.find((write) => write.key === key)?.path;
}

const WRITES_KEPT = 50;

export function recordWrite(record: DelegationRecord, key: string, path: string): DelegationRecord {
  return { ...record, writes: [...record.writes.filter((write) => write.key !== key), { key, path }].slice(-WRITES_KEPT) };
}

/** Forget every write that produced `path` (the document was deleted). */
export function forgetWrites(record: DelegationRecord, path: string): DelegationRecord {
  const kept = record.writes.filter((write) => write.path !== path);
  return kept.length === record.writes.length ? record : { ...record, writes: kept };
}
