/**
 * Resume in a fixed order: query the real state → check what already exists →
 * decide what changed → only then hand a brief to an agent.
 *
 * A wait whose submit response was lost is found again by its request key,
 * never resubmitted blind. Nothing an earlier session merely intended counts
 * as having happened.
 */
import { type BudgetKey, type DelegationRecord, lastDecision, pendingGate, pendingWaits, resolveWait, budgetLeft, type Wait } from "./delegation/model.js";
import { approvalLine, decisionLine } from "./delegation/status.js";
import type { MolabClient } from "./molab/client.js";
import { executionRef, parseRef } from "./molab/refs.js";
import { type Execution, TERMINAL_STATUSES } from "./molab/schemas.js";

export type WaitObservation =
  | { wait: Wait; kind: "terminal"; execution: Execution }
  | { wait: Wait; kind: "running"; execution: Execution }
  | { wait: Wait; kind: "not-submitted" }
  | { wait: Wait; kind: "expired" }
  | { wait: Wait; kind: "unreachable"; error: string };

export interface Reconciled {
  record: DelegationRecord;
  observations: WaitObservation[];
  /** True when the record differs from the input and must be written back. */
  changed: boolean;
}

/** Find the attempt a wait is about: by execution id when known, else by request key. */
function pick(wait: Wait, executions: readonly Execution[]): Execution | undefined {
  const ref = parseRef(wait.target);
  if (ref.execution !== undefined) return executions.find((execution) => execution.id === ref.execution);
  if (wait.request_key === undefined || wait.request_key === null) return undefined;
  return executions.find((execution) => execution.executor.request_key === wait.request_key);
}

export async function observeWait(molab: MolabClient, wait: Wait, now: Date, signal?: AbortSignal): Promise<WaitObservation> {
  if (wait.deadline !== undefined && wait.deadline !== null && Date.parse(wait.deadline) <= now.getTime()) return { wait, kind: "expired" };
  const ref = parseRef(wait.target);
  if (ref.experiment === undefined || ref.run === undefined) return { wait, kind: "unreachable", error: `wait target ${wait.target} is not a run or execution ref` };
  try {
    const at = { project: wait.project ?? "-", experiment: ref.experiment, run: ref.run };
    const execution = pick(wait, await molab.listExecutions(at, signal));
    if (execution === undefined) return { wait, kind: "not-submitted" };
    return { wait, kind: TERMINAL_STATUSES.has(execution.status) ? "terminal" : "running", execution };
  } catch (error) {
    return { wait, kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Observe every pending wait and fold what is settled into a new record. */
export async function reconcile(molab: MolabClient, record: DelegationRecord, now = new Date(), signal?: AbortSignal): Promise<Reconciled> {
  const observations = await Promise.all(pendingWaits(record).map((wait) => observeWait(molab, wait, now, signal)));
  let next = record;
  for (const observation of observations) {
    if (observation.kind === "terminal") next = resolveWait(next, observation.wait.id, observation.execution.status);
    else if (observation.kind === "expired") next = resolveWait(next, observation.wait.id, "deadline passed", "expired");
    else if (observation.kind === "running" && parseRef(observation.wait.target).execution === undefined) {
      // The submit response was lost but the attempt exists: pin the wait to it.
      const ref = parseRef(observation.wait.target);
      const target = executionRef(ref.experiment!, ref.run!, observation.execution.id);
      next = { ...next, waits: next.waits.map((wait) => (wait.id === observation.wait.id ? { ...wait, target } : wait)) };
    }
  }
  return { record: next, observations, changed: next !== record };
}

/**
 * Fold the waits a reconcile settled onto the latest stored record. The record
 * may have changed since it was read; only still-pending waits take the
 * reconciled value.
 */
export function foldSettled(latest: DelegationRecord, reconciled: DelegationRecord): DelegationRecord {
  const byId = new Map(reconciled.waits.map((wait) => [wait.id, wait]));
  const waits = latest.waits.map((wait) => (wait.state === "pending" ? (byId.get(wait.id) ?? wait) : wait));
  const stillWaiting = waits.some((wait) => wait.state === "pending");
  return { ...latest, waits, state: latest.state === "waiting" && !stillWaiting ? "open" : latest.state };
}

function describe(observation: WaitObservation): string {
  const { wait } = observation;
  switch (observation.kind) {
    case "terminal":
      return `- ${wait.id}: ${wait.target} ended **${observation.execution.status}**${observation.execution.error ? ` (${JSON.stringify(observation.execution.error).slice(0, 200)})` : ""}. Planned next: ${wait.on_resolve || "decide"}.`;
    case "running":
      return `- ${wait.id}: attempt ${observation.execution.id} is still ${observation.execution.status}.`;
    case "not-submitted":
      return `- ${wait.id}: no attempt exists for request key ${wait.request_key ?? "(none)"}. It was never created; starting it again with the same key is safe.`;
    case "expired":
      return `- ${wait.id}: its deadline passed without a result.`;
    case "unreachable":
      return `- ${wait.id}: could not be checked (${observation.error}).`;
  }
}

const SETTLED_SHOWN = 10;

/** The most recent settled waits and their outcomes. */
function settledLines(record: DelegationRecord): string[] {
  const settled = record.waits.filter((wait) => wait.state !== "pending").slice(-SETTLED_SHOWN);
  if (settled.length === 0) return [];
  return [["Settled waits (latest last):", ...settled.map((wait) => `- ${wait.id}: ${wait.target} → ${wait.state}${wait.outcome ? ` (${wait.outcome})` : ""}. Planned next: ${wait.on_resolve || "decide"}.`)].join("\n")];
}

/** The message a resumed or woken supervisor receives. */
export function resumeBrief(path: string, reconciled: Reconciled): string {
  const { record, observations } = reconciled;
  const left = Object.entries(budgetLeft(record)).map(([key, value]) => `${key}: spent ${record.spent[key as BudgetKey] ?? 0}, left ${value}`);
  return [
    `Research delegation ${path} needs your attention (state: ${record.state}).`,
    `Goal: ${record.goal}`,
    ["Acceptance:", ...(record.acceptance.length === 0 ? ["- (none declared)"] : record.acceptance.map((item) => `- ${item}`))].join("\n"),
    `Plan: ${record.current_plan ?? "none yet (research_plan)"}`,
    `Last decision: ${decisionLine(lastDecision(record))}`,
    personLines(record),
    answerLines(record),
    approvalLines(record),
    observations.length === 0 ? "No waits are pending." : ["Checked against molab just now:", ...observations.map(describe)].join("\n"),
    ...settledLines(record),
    `Budget: ${left.length === 0 ? "unlimited" : left.join("; ")}.`,
    attemptLines(record),
    "Next: assess each finished attempt from its report (research_assess report: <path>); read outputs (molab_read_outputs) only if the report is missing, invalid or contradicts the acceptance criteria. Then research_decide. Do not resubmit anything listed as still running.",
  ].join("\n\n");
}

/** What a blocked delegation waits for from a person: the gate, the questions, and how the answer is recorded. */
function personLines(record: DelegationRecord): string {
  if (record.state !== "blocked") return "Waiting on a person: no.";
  const gate = pendingGate(record);
  const head = `Waiting on a person${gate === undefined ? "" : ` (gate ${gate.gate}, target ${gate.target})`}; their answer arrives as the next prompt. Record it with research_resume${gate === undefined ? "" : ` (approve: {gate: "${gate.gate}", target: "${gate.target}"} only when they clearly approved that target)`}, then continue:`;
  return [head, ...(record.questions.length === 0 ? ["- (no question recorded)"] : record.questions.map((question) => `- ${question}`))].join("\n");
}

function approvalLines(record: DelegationRecord): string {
  if (record.approvals.length === 0) return "Approvals: none yet.";
  return ["Approvals:", ...record.approvals.map((approval) => `- ${approvalLine(approval)}`)].join("\n");
}

const SHOWN_ANSWERS = 5;
function answerLines(record: DelegationRecord): string {
  if (record.answers.length === 0) return "Answers from people: none.";
  const shown = record.answers.slice(-SHOWN_ANSWERS);
  return ["Answers from people (verbatim; do not ask again):", ...shown.map((answer) => `- ${answer.by} (${answer.path}): ${answer.text}`)].join("\n");
}

/** Recent worker attempts, newest last: who ran, how it ended, when, and where its report is. */
const SHOWN_ATTEMPTS = 5;
function attemptLines(record: DelegationRecord): string {
  if (record.attempts.length === 0) return "Worker attempts: none.";
  const shown = record.attempts.slice(-SHOWN_ATTEMPTS);
  const hidden = record.attempts.length - shown.length;
  const rows = shown.map((attempt) => {
    const when = [attempt.started_at, attempt.ended_at].filter(Boolean).join(" → ");
    const summary = attempt.summary.length > 160 ? `${attempt.summary.slice(0, 160)}…` : attempt.summary;
    const report = attempt.report ? `report: ${attempt.report}` : attempt.check ? `report: ${attempt.check}` : attempt.ended_at ? "report: not filed" : "report: pending";
    return `- ${attempt.id} (${attempt.worker}) ${attempt.status || "running"}${when ? `, ${when}` : ""}${summary ? `: ${summary}` : ""}\n  ${report}`;
  });
  return [`Worker attempts (${record.attempts.length}${hidden > 0 ? `, last ${shown.length} shown` : ""}):`, ...rows].join("\n");
}
