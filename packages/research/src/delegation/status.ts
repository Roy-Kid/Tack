/**
 * The narrative of a Delegation document: a status digest regenerated on every
 * write, so molab's own knowledge view is the supervision view. It answers the
 * five things a supervisor needs at a glance: the goal and progress, what is
 * running or awaited, the evidence behind the current decision, the
 * capability versions in use, and what comes next with the budget left.
 */
import { type Approval, type Attempt, BUDGET_KEYS, budgetLeft, type Decision, type DelegationRecord, lastDecision, pendingGate, pendingWaits } from "./model.js";

export interface StatusExtras {
  /** One line: what the supervisor intends to do next. */
  next?: string;
  /** Knowledge paths of the evidence behind the latest decision. */
  evidence?: readonly string[];
  /** Capability versions in use (milestone 2 fills these). */
  capabilities?: readonly string[];
}

const line = (label: string, value: string) => `- **${label}:** ${value}`;

function budgetLines(record: DelegationRecord): string[] {
  const left = budgetLeft(record);
  return BUDGET_KEYS.filter((key) => record.budget[key] !== null && record.budget[key] !== undefined).map(
    (key) => `  - ${key}: spent ${record.spent[key] ?? 0} of ${record.budget[key]} (left ${left[key]})`,
  );
}

/** One approval as a line: the gate, its target, who and when. */
export function approvalLine(approval: Approval): string {
  return `${approval.gate} ${approval.target} by ${approval.by} at ${approval.at}${approval.note ? ` (${approval.note})` : ""}`;
}

/** The gate a blocked delegation waits on and its questions, as one line; "nobody" when it is not blocked. */
export function personLine(record: DelegationRecord): string {
  if (record.state !== "blocked") return "nobody";
  const gate = pendingGate(record);
  const questions = record.questions.length === 0 ? "(no question recorded)" : record.questions.join(" | ");
  return `${gate === undefined ? "a person" : `a person: gate ${gate.gate} for ${gate.target}`} — ${questions}`;
}

export function renderStatus(title: string, record: DelegationRecord, extras: StatusExtras = {}): string {
  const waits = pendingWaits(record);
  const lastAttempt = record.attempts.at(-1);
  const budget = budgetLines(record);
  return [
    `# ${title}`,
    "",
    "## Status",
    "",
    line("Goal", record.goal),
    line("Scope", record.scope),
    line("State", record.state),
    line("Plan", record.current_plan ?? "none yet"),
    line("Waiting on a person", personLine(record)),
    line("Waiting on", waits.length === 0 ? "nothing" : waits.map((wait) => `${wait.target} (${wait.on_resolve || "then decide"})`).join("; ")),
    line("Last worker attempt", lastAttempt === undefined ? "none" : attemptLine(lastAttempt)),
    line("Last decision", decisionLine(lastDecision(record))),
    line("Evidence", extras.evidence?.length ? extras.evidence.join(", ") : "none recorded"),
    line("Capabilities", extras.capabilities?.length ? extras.capabilities.join(", ") : "defaults"),
    line("Next", extras.next ?? "decide from the latest evidence"),
    line("Budget", budget.length === 0 ? "unlimited" : ""),
    ...budget,
    "",
    "## Acceptance",
    "",
    ...(record.acceptance.length === 0 ? ["- (none declared)"] : record.acceptance.map((item) => `- ${item}`)),
    "",
    "## Stop conditions",
    "",
    ...(record.stop_conditions.length === 0 ? ["- (none declared)"] : record.stop_conditions.map((item) => `- ${item}`)),
    "",
    "## Answers from people",
    "",
    ...(record.answers.length === 0 ? ["- (none yet)"] : record.answers.map((answer) => `- ${answer.by} (${answer.path}): ${answer.text}`)),
    "",
    "## Approvals",
    "",
    ...(record.approvals.length === 0 ? ["- (none yet)"] : record.approvals.map((approval) => `- ${approvalLine(approval)}`)),
    "",
    "## Decisions",
    "",
    ...(record.decisions.length === 0
      ? ["- (none yet)"]
      : record.decisions.flatMap((decision) => [
          `- ${decision.at} **${decision.kind}** ${decision.name}: ${decision.reason}${decision.next ? ` — next: ${decision.next}` : ""}`,
          ...(decision.questions.length > 0 ? decision.questions.map((question) => `  - asked: ${question}`) : []),
          ...(decision.evidence.length > 0 ? [`  - evidence: ${decision.evidence.join(", ")}`] : []),
        ])),
    "",
  ].join("\n");
}

/** The latest decision as one line. */
export function decisionLine(decision: Decision | undefined): string {
  return decision === undefined ? "none yet" : `${decision.kind}: ${decision.name}${decision.next ? ` — next: ${decision.next}` : ""}`;
}

function attemptLine(attempt: Attempt): string {
  const report = attempt.report ? `report ${attempt.report}` : attempt.check ? `report: ${attempt.check}` : "report pending";
  return `${attempt.id} (${attempt.worker}): ${attempt.status || "running"} — ${attempt.summary || "(no summary)"}; ${report}`;
}
