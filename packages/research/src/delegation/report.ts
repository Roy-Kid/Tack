/**
 * The worker report: what every worker (in-process, Claude Code, Codex) hands
 * back, and Tack's mirror of molab's `WorkerReportRecord` (a Report document
 * whose record kind is `worker_report`). The same contract in two forms: the
 * zod schema validates what came back; the hand-written JSON Schema twin is
 * what a provider with `outputSchema` support asks its child to fill, written
 * in the subset DSH enforces (type / oneOf / properties / required /
 * additionalProperties / items / enum / const, plus annotations).
 *
 * Collections default to empty: molab's frontmatter omits empty values, so a
 * record written with `[]` reads back without the key.
 */
import { z } from "zod";
import { clip, errorMessage } from "../text.js";
import { Sha256, Tokens } from "./model.js";

export const OUTCOMES = ["done", "partial", "blocked", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const VERDICTS = ["pass", "fail", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const COMPONENTS = ["molpy", "atomiverse", "molvis", "molab", "dsh", "tack"] as const;
export type Component = (typeof COMPONENTS)[number];

const Check = z.object({
  verdict: z.enum(VERDICTS),
  value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  note: z.string().nullish(),
});
export type Check = z.infer<typeof Check>;

const Product = z.object({ path: z.string().min(1), kind: z.string().min(1), description: z.string().default("") });
export type Product = z.infer<typeof Product>;

const Deviation = z.object({ item: z.string().min(1), expected: z.string().default(""), actual: z.string().default("") });

export const CapabilityGap = z.object({
  component: z.enum(COMPONENTS),
  title: z.string().min(1),
  repro: z.string().min(1),
  version: z.string().nullish(),
  fix: z.string().nullish(),
});
export type CapabilityGap = z.infer<typeof CapabilityGap>;

/**
 * What a worker writes. Unknown keys are dropped, not refused: a worker that
 * says more than the contract is not a failed worker.
 */
export const WorkerReport = z.object({
  outcome: z.enum(OUTCOMES),
  summary: z.string().min(1),
  checks: z.record(z.string(), Check).default({}),
  products: z.array(Product).default([]),
  files_changed: z.array(z.string()).default([]),
  workflow: z.string().nullish(),
  protocol_deviations: z.array(Deviation).default([]),
  capability_gaps: z.array(CapabilityGap).default([]),
  open_questions: z.array(z.string()).default([]),
  next: z.string().nullish(),
  tokens: Tokens.default("unavailable"),
});
export type WorkerReport = z.infer<typeof WorkerReport>;

/** The report as molab stores it: the worker's fields plus the ones Tack adds when filing it. */
export const WorkerReportRecord = WorkerReport.extend({
  kind: z.literal("worker_report"),
  delegation: z.string().min(1),
  attempt: z.string().min(1),
  brief: z.string().min(1),
  brief_digest: Sha256,
});
export type WorkerReportRecord = z.infer<typeof WorkerReportRecord>;

/** The worker-facing field table, one row per field: name, type, meaning. The brief renders it. */
export const REPORT_FIELDS: readonly (readonly [field: string, type: string, meaning: string])[] = [
  ["outcome", "done | partial | blocked | failed", "done: every expected product delivered and checked; partial: some of them; blocked: could not proceed (say why in open_questions); failed: tried, did not work"],
  ["summary", "string", "What was done and what the evidence shows, in a few sentences"],
  ["checks", "{name: {verdict: pass | fail | unknown, value?, note?}}", "One entry per expected product and acceptance criterion, keyed by its name; unknown when it could not be checked"],
  ["products", "[{path, kind, description}]", "Every file delivered, as a workspace-relative path; kind such as structure, data, figure, script, log"],
  ["files_changed", "[path]", "Files written or changed that are not products"],
  ["workflow", "path?", "The workflow file the products came from, when there is one"],
  ["protocol_deviations", "[{item, expected, actual}]", "Every departure from the brief's protocol, however small"],
  ["capability_gaps", "[{component, title, repro, version?, fix?}]", "A tool that is missing or broken: component is one of molpy, atomiverse, molvis, molab, dsh, tack; repro the exact steps; version what was installed"],
  ["open_questions", "[string]", "What you could not decide or read; a question here is worth more than a guess"],
  ["next", "string?", "What you would do next, if anything"],
  ["tokens", '"unavailable" | {input, output, cache_read?, cache_write?, reasoning?}', 'Your token usage when you know it, else "unavailable"'],
];

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;

/**
 * The JSON Schema twin of {@link WorkerReport}, for a provider's `outputSchema`.
 * `checks` is validated by the zod schema after capture: DSH's subset cannot
 * describe a map with typed values.
 */
export const WORKER_REPORT_SCHEMA = {
  type: "object",
  description: "A worker's report to the research supervisor.",
  properties: {
    outcome: { type: "string", enum: [...OUTCOMES], description: "done: every expected product delivered and checked; partial; blocked (say why in open_questions); failed." },
    summary: { type: "string", description: "What was done and what the evidence shows, in a few sentences." },
    checks: { type: "object", additionalProperties: true, description: "name -> {verdict: pass|fail|unknown, value?, note?}; one entry per expected product and acceptance criterion." },
    products: {
      type: "array",
      items: { type: "object", properties: { path: STRING, kind: STRING, description: STRING }, required: ["path", "kind"] },
      description: "Every file delivered, as a workspace-relative path.",
    },
    files_changed: { type: "array", items: STRING },
    workflow: { type: "string", description: "The workflow file the products came from, when there is one." },
    protocol_deviations: { type: "array", items: { type: "object", properties: { item: STRING, expected: STRING, actual: STRING }, required: ["item"] } },
    capability_gaps: {
      type: "array",
      items: {
        type: "object",
        properties: { component: { type: "string", enum: [...COMPONENTS] }, title: STRING, repro: STRING, version: STRING, fix: STRING },
        required: ["component", "title", "repro"],
      },
    },
    open_questions: { type: "array", items: STRING },
    next: STRING,
    tokens: {
      oneOf: [
        { type: "string", enum: ["unavailable"] },
        { type: "object", properties: { input: INTEGER, output: INTEGER, cache_read: INTEGER, cache_write: INTEGER, reasoning: INTEGER }, required: ["input", "output"] },
      ],
    },
  },
  required: ["outcome", "summary"],
} as const;

export type ParsedReport = { ok: true; report: WorkerReport } | { ok: false; problems: string[] };

const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)\n[ \t]*```/g;

/** The last fenced ```json block of a text, or undefined when there is none. */
export function lastJsonBlock(text: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(JSON_FENCE)) last = match[1];
  return last?.trim();
}

/**
 * A worker's report from what its provider returned: a structured value when
 * the provider captured one, else the last fenced ```json block of its text.
 */
export function parseWorkerReport(raw: unknown): ParsedReport {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    const block = lastJsonBlock(raw);
    if (block === undefined) {
      return { ok: false, problems: [raw.trim() === "" ? "the worker produced no output" : "the output does not end with a fenced ```json block holding the report"] };
    }
    try {
      candidate = JSON.parse(block);
    } catch (error) {
      return { ok: false, problems: [`the last \`\`\`json block is not valid JSON: ${errorMessage(error)}`] };
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return { ok: false, problems: ["the report is not a JSON object"] };
  const parsed = WorkerReport.safeParse(candidate);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "report"}: ${issue.message}`) };
  return { ok: true, report: parsed.data };
}

export interface Level {
  verdict: Verdict;
  reason: string;
}

const REASON_CHARS = 300;

function describeCheck([name, check]: [string, Check]): string {
  const value = check.value === undefined || check.value === null ? "" : ` (${String(check.value)})`;
  const note = check.note === undefined || check.note === null || check.note === "" ? "" : ` — ${check.note}`;
  return `${name}: ${check.verdict}${value}${note}`;
}

/**
 * The execution and data verdicts a report supports, for `research_assess`
 * to start from: execution from the outcome, data from the checks. Analysis
 * and conclusion stay the supervisor's.
 */
export function verdictsFrom(report: WorkerReport): { execution: Level; data: Level } {
  const summary = clip(report.summary, REASON_CHARS);
  const execution: Level =
    report.outcome === "done"
      ? { verdict: "pass", reason: `the worker reports done: ${summary}` }
      : report.outcome === "partial"
        ? { verdict: "unknown", reason: `the worker reports partial completion: ${summary}` }
        : { verdict: "fail", reason: `the worker reports ${report.outcome}: ${summary}` };
  const entries = Object.entries(report.checks);
  const failed = entries.filter(([, check]) => check.verdict === "fail");
  const unknown = entries.filter(([, check]) => check.verdict === "unknown");
  const deviations = report.protocol_deviations.length === 0 ? "" : `; ${report.protocol_deviations.length} protocol deviation(s): ${report.protocol_deviations.map((item) => item.item).join(", ")}`;
  const data: Level =
    entries.length === 0
      ? { verdict: "unknown", reason: `the report lists no checks${deviations}` }
      : failed.length > 0
        ? { verdict: "fail", reason: `failed checks: ${failed.map(describeCheck).join("; ")}${deviations}` }
        : unknown.length > 0
          ? { verdict: "unknown", reason: `unchecked: ${unknown.map(describeCheck).join("; ")}${deviations}` }
          : { verdict: "pass", reason: `all ${entries.length} checks pass: ${entries.map(describeCheck).join("; ")}${deviations}` };
  return { execution, data };
}
