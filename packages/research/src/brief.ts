/**
 * The brief a worker is dispatched with: everything the supervisor knows that
 * the worker needs, compiled once from the delegation, immutable, and kept as
 * a molab Note (record kind `brief`) with the sha256 of its body. A worker
 * never has to rediscover what a person already answered, what an earlier
 * round found, or how the workspace is laid out.
 *
 * Pure: no molab, no DSH. The dispatch tool gathers the inputs.
 */
import { createHash } from "node:crypto";
import { type Attempt, BUDGET_KEYS, budgetLeft, type DelegationRecord, lastDecision } from "./delegation/model.js";
import { type CapabilityGap, REPORT_FIELDS, type WorkerReport } from "./delegation/report.js";
import { clip } from "./text.js";

export interface BriefProtocol {
  /** An execution ref (`molab:…/execution/…`) to reproduce exactly. */
  reproduce?: string;
  /** An independent realization instead of a reproduction. */
  realization?: "independent";
  seed?: number;
  /** Stereochemistry policy. */
  stereo?: string;
  /** Charge neutralization policy. */
  charges?: string;
  notes?: string;
}

/** An earlier attempt and the report it was linked to, when it has one. */
export interface EarlierAttempt {
  attempt: Attempt;
  report?: WorkerReport;
}

/** draft: write the workflow and dry-run it, executing nothing; run: execute the approved workflow. */
export type BriefMode = "draft" | "run";

export interface BriefInput {
  delegation: string;
  record: DelegationRecord;
  round: number;
  worker: string;
  /** What this round may do (default run). */
  mode?: BriefMode;
  /** The dry_run approval a run round rests on, when a person gave one. */
  approval?: { target: string; by: string; at: string };
  /** Whether the worker runs in this process, with the molab_* tools. */
  inProcess: boolean;
  /** Whether the worker's provider captures a structured report (outputSchema). */
  structured: boolean;
  /** The served workspace on disk. */
  cwd: string;
  task: string;
  expected: readonly string[];
  protocol: BriefProtocol;
  plan?: { path: string; body: string };
  attempts: readonly EarlierAttempt[];
  attachments: readonly { path: string; text: string }[];
  /** The attempt this round continues, when it continues one. */
  continues?: string;
}

/** The Note record molab validates (`BriefRecord`). */
export interface BriefRecord {
  kind: "brief";
  delegation: string;
  round: number;
  digest: string;
  inputs: string[];
  protocol: BriefProtocol;
}

export interface Brief {
  body: string;
  /** sha256 of the body, lowercase hex. */
  digest: string;
  record: BriefRecord;
}

const EARLIER_SHOWN = 3;
const PLAN_CHARS = 6_000;
const ATTACHMENT_CHARS = 16_000;
const SUMMARY_CHARS = 600;
export const PROBE_CAP = 5;

const list = (items: readonly string[], empty = "(none)"): string[] => (items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${item}`));
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function goalSection(input: BriefInput): string[] {
  const { record } = input;
  const left = budgetLeft(record);
  const budget = BUDGET_KEYS.filter((key) => left[key] !== undefined).map((key) => `${key}: ${left[key]} left of ${record.budget[key]}`);
  return [
    "## Goal, scope, acceptance, stop conditions, budget",
    "",
    `- Goal: ${record.goal}`,
    `- Scope: ${record.scope}`,
    `- Round: ${input.round}${input.continues !== undefined ? ` (continues attempt ${input.continues})` : ""}`,
    "",
    "Acceptance (what must hold for the work to count):",
    ...list(record.acceptance, "none declared"),
    "",
    "Stop conditions:",
    ...list(record.stop_conditions, "none declared"),
    "",
    `Budget left: ${budget.length === 0 ? "unlimited" : budget.join("; ")}.`,
  ];
}

function taskSection(input: BriefInput): string[] {
  return ["## Task (this round)", "", input.task.trim(), "", "Expected products (report a check for each, by this name):", ...list(input.expected)];
}

function modeSection(input: BriefInput): string[] {
  if ((input.mode ?? "run") === "draft") {
    const validate = input.inProcess
      ? "molab_dry_run(delegation, experiment)"
      : "`molab workflow dry-run <script.py> --json` (it creates no records and prints one JSON object per line per bound experiment: experiment {id, name, path}, workflow, waves, branches, runs, tasks)";
    return [
      "## Mode: draft (nothing executes this round)",
      "",
      `- Write or extend the experiment's workflow.py, then preview it with ${validate}.`,
      "- Do not execute: no `molab run` (not even `molab run --dry-run`, which creates run records), no molab_start_execution. Such a call is refused (TACK_GATE_DRYRUN) until a person approves the dry run; the supervisor asks them after your report.",
      "- Save the dry-run JSON (waves, branches, runs) under the experiment's scratch/ and report it as a product of kind dry_run, with the experiment path it names in its description; name the workflow in `workflow`. Python probes and other commands are fine.",
    ];
  }
  const approval = input.approval;
  return [
    "## Mode: run",
    "",
    approval === undefined
      ? "- Execute the workflow as planned."
      : `- The dry run of ${approval.target} was approved by ${approval.by} at ${approval.at}: execute it as approved. A change to the workflow is a protocol deviation and needs a new dry run.`,
  ];
}

function protocolSection(protocol: BriefProtocol): string[] {
  const rows = [
    protocol.reproduce !== undefined ? `- Reproduce exactly: ${protocol.reproduce} (same inputs, same parameters, same seed; the result must match it).` : undefined,
    protocol.realization !== undefined ? `- Realization: ${protocol.realization} (a new realization, not a reproduction).` : undefined,
    protocol.seed !== undefined ? `- Seed: ${protocol.seed}.` : undefined,
    protocol.stereo !== undefined ? `- Stereochemistry: ${protocol.stereo}.` : undefined,
    protocol.charges !== undefined ? `- Charges: ${protocol.charges}.` : undefined,
    protocol.notes !== undefined ? `- ${protocol.notes}` : undefined,
  ].filter((row): row is string => row !== undefined);
  return [
    "## Protocol",
    "",
    ...(rows.length === 0 ? ["- No protocol was fixed for this round: state every choice you make (seed, stereochemistry, charges) in the report."] : rows),
    "",
    "Every departure from this protocol, however small, goes in protocol_deviations. Do not adapt silently.",
  ];
}

function planSection(plan: BriefInput["plan"]): string[] {
  if (plan === undefined) return ["## Plan", "", "- No plan is recorded yet."];
  return ["## Plan", "", `Path: ${plan.path}`, "", clip(plan.body.trim(), PLAN_CHARS)];
}

function answersSection(record: DelegationRecord): string[] {
  const rows = record.answers.map((answer) => `- ${answer.by} (${answer.path}): ${answer.text}`);
  return ["## What people answered (verbatim; do not ask these again)", "", ...(rows.length === 0 ? ["- nothing yet"] : rows)];
}

function decisionSection(record: DelegationRecord): string[] {
  const decision = lastDecision(record);
  if (decision === undefined) return ["## Last decision", "", "- none yet"];
  return ["## Last decision", "", `- ${decision.kind}: ${decision.name} — ${clip(decision.reason, SUMMARY_CHARS)}${decision.next ? `; next: ${decision.next}` : ""}`];
}

function checksTable(report: WorkerReport): string[] {
  const entries = Object.entries(report.checks);
  if (entries.length === 0) return ["  (no checks reported)"];
  return entries.map(([name, check]) => `  - ${name}: ${check.verdict}${check.value !== undefined && check.value !== null ? ` (${String(check.value)})` : ""}${check.note ? ` — ${check.note}` : ""}`);
}

function attemptLines({ attempt, report }: EarlierAttempt): string[] {
  const head = `- ${attempt.id} (${attempt.worker}) ${attempt.status || "running"}${attempt.ended_at ? `, ended ${attempt.ended_at}` : ""}`;
  if (report === undefined) {
    const note = attempt.check ? `report: ${attempt.check}` : attempt.ended_at ? "no report linked" : "still running";
    return [head, `  task: ${clip(attempt.task, 200)}`, `  ${note}${attempt.summary ? `; last words: ${clip(attempt.summary, SUMMARY_CHARS)}` : ""}`];
  }
  return [
    head,
    `  task: ${clip(attempt.task, 200)}`,
    `  outcome: ${report.outcome} — ${clip(report.summary, SUMMARY_CHARS)}`,
    `  report: ${attempt.report ?? "(unlinked)"}`,
    "  checks:",
    ...checksTable(report),
    ...(report.products.length > 0 ? ["  products:", ...report.products.map((product) => `  - ${product.path} (${product.kind})${product.description ? `: ${product.description}` : ""}`)] : []),
    ...(report.protocol_deviations.length > 0 ? ["  protocol deviations:", ...report.protocol_deviations.map((item) => `  - ${item.item}: expected ${item.expected}, actual ${item.actual}`)] : []),
    ...(report.open_questions.length > 0 ? ["  open questions:", ...report.open_questions.map((question) => `  - ${question}`)] : []),
    ...(report.next ? [`  next: ${report.next}`] : []),
  ];
}

function attemptsSection(attempts: readonly EarlierAttempt[]): string[] {
  const shown = attempts.slice(-EARLIER_SHOWN);
  const hidden = attempts.length - shown.length;
  return [
    `## Earlier attempts${hidden > 0 ? ` (last ${shown.length} of ${attempts.length})` : ""}`,
    "",
    ...(shown.length === 0 ? ["- none: this is the first round"] : shown.flatMap(attemptLines)),
  ];
}

/** The workflow the latest report names, if any: the one a later round extends and a dry-run approval is about. */
export function currentWorkflow(attempts: readonly EarlierAttempt[]): string | undefined {
  return [...attempts].reverse().find((item) => item.report?.workflow)?.report?.workflow ?? undefined;
}

function workflowSection(attempts: readonly EarlierAttempt[]): string[] {
  const workflow = currentWorkflow(attempts);
  return [
    "## Workflow",
    "",
    workflow
      ? `- Current workflow: ${workflow}. It is this experiment's one workflow: change it rather than writing a second entrypoint; split what grows into modules under the experiment's lib/.`
      : "- No workflow is recorded yet.",
  ];
}

/** Known gaps, one per component and title. */
export function knownGaps(attempts: readonly EarlierAttempt[]): CapabilityGap[] {
  const seen = new Map<string, CapabilityGap>();
  for (const { report } of attempts) for (const gap of report?.capability_gaps ?? []) seen.set(`${gap.component}\n${gap.title}`, gap);
  return [...seen.values()];
}

function gapsSection(attempts: readonly EarlierAttempt[]): string[] {
  const gaps = knownGaps(attempts);
  return [
    "## Known capability gaps (do not rediscover; work around or report)",
    "",
    ...(gaps.length === 0 ? ["- none recorded"] : gaps.map((gap) => `- ${gap.component}: ${gap.title}${gap.version ? ` (${gap.version})` : ""} — ${gap.repro}${gap.fix ? `; fix: ${gap.fix}` : ""}`)),
  ];
}

function attachmentsSection(attachments: BriefInput["attachments"]): string[] {
  if (attachments.length === 0) return [];
  return ["## Attachments", "", ...attachments.flatMap((item) => [`### ${item.path}`, "", "```", clip(item.text, ATTACHMENT_CHARS), "```", ""])];
}

function rulesSection(input: BriefInput): string[] {
  const molab = input.inProcess
    ? [
        "- Molab: use the molab_* tools (molab_create_experiment, molab_create_run, molab_start_execution with mode rerun to recompute, molab_read_outputs) for every molab operation. Do not run the `molab` CLI from the shell: each call is a process start.",
      ]
    : [
        "- Molab: use the `molab` CLI (`molab run --rerun --fresh` to recompute a run). Do not write knowledge documents (`molab knowledge write`): everything you found goes in your report below, which Tack files.",
      ];
  return [
    "## Workspace rules",
    "",
    `- Work in ${input.cwd} (the served workspace). Scratch files go only under experiments/<experiment>/scratch/; finished results are run products.`,
    "- Never hand-edit index.md, executions/ or .molab/; molab owns them.",
    "- Register only final products as assets (structures, force fields, simulation inputs, figures). Logs and per-task evidence JSON stay in the task's out/ directory; never register them.",
    "- One workflow per experiment: workflow.py is the entrypoint; split it into modules under experiments/<experiment>/lib/ once it outgrows one file (well before ~800 lines), importing them from workflow.py.",
    "- Create an experiment only for the stage you are working on now; never scaffold experiments for roadmap stages that have not started.",
    "- Leave the workspace valid: before you report, run `molab validate --new-only` and fix every error it lists. A turn that leaves a new error is not accepted.",
    ...molab,
    `- Probe cap: at most ${PROBE_CAP} exploratory commands (reading an API, listing files) before you start the task. This brief carries what you need.`,
    "- Report, do not guess: when something cannot be read or a value cannot be obtained, say so in the report (outcome blocked or partial, and the question in open_questions). Never invent a value.",
    "- You do not write research records (research_*) or start other workers; the supervisor records and decides from your report.",
  ];
}

function reportSection(input: BriefInput): string[] {
  const how = input.structured
    ? "Submit it with the structured_output tool when you are done; it is the only way the supervisor sees it."
    : "End your reply with exactly one fenced ```json block holding it, and nothing after the block.";
  return [
    "## Report (required)",
    "",
    how,
    "",
    "| field | type | meaning |",
    "| --- | --- | --- |",
    ...REPORT_FIELDS.map(([field, type, meaning]) => `| ${field} | ${cell(type)} | ${cell(meaning)} |`),
    "",
    "A report with outcome blocked or failed and honest checks is a good report. A report that claims done without the products is not.",
  ];
}

export function compileBrief(input: BriefInput): Brief {
  const body = [
    `# Brief: round ${input.round} of ${input.delegation}`,
    "",
    `Worker: ${input.worker}${input.inProcess ? " (in-process)" : ""} · Delegation: ${input.delegation}`,
    "",
    ...goalSection(input),
    "",
    ...taskSection(input),
    "",
    ...modeSection(input),
    "",
    ...protocolSection(input.protocol),
    "",
    ...planSection(input.plan),
    "",
    ...answersSection(input.record),
    "",
    ...decisionSection(input.record),
    "",
    ...attemptsSection(input.attempts),
    "",
    ...workflowSection(input.attempts),
    "",
    ...gapsSection(input.attempts),
    "",
    ...attachmentsSection(input.attachments),
    ...rulesSection(input),
    "",
    ...reportSection(input),
    "",
  ].join("\n");
  const digest = createHash("sha256").update(body).digest("hex");
  const inputs = [
    ...(input.plan !== undefined ? [input.plan.path] : []),
    ...input.attempts.flatMap((item) => (item.attempt.report ? [item.attempt.report] : [])),

  ];
  return {
    body,
    digest,
    record: { kind: "brief", delegation: input.delegation, round: input.round, digest, inputs: [...new Set(inputs)], protocol: { ...input.protocol } },
  };
}
