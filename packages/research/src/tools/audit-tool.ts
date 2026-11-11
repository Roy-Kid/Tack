/**
 * Audit a workspace Tack did not write (or did): molab's own layout and
 * knowledge rules over the served scope, plus the conventions Tack's records
 * follow (a Delegation Tack can read, an assessment Report, and no decision,
 * answer or capability gap kept as a document of its own). Read-only: it
 * reports, with the hint molab gives, and fixes nothing.
 */
import { z } from "zod";
import { readCampaign, renderCampaign } from "../campaign.js";
import type { ValidationRow } from "../molab/schemas.js";
import type { ResearchDeps, ToolSpec } from "./types.js";

const Verdict = z.looseObject({ verdict: z.enum(["pass", "fail", "unknown"]), reason: z.string() });
const Assessment = z.looseObject({ execution: Verdict, data: Verdict, analysis: Verdict, conclusion: Verdict });

const TACK_HINTS: Record<string, string> = {
  "tack.delegation_unreadable": "Tack cannot read this Delegation; molab's knowledge.record finding (if any) says why. Rewrite its record, or leave it for its own tool.",
  "tack.decision_document":
    "Decisions and answers live in their Delegation's log, and science capability gaps in the one capability-gaps Todo; a document per decision is clutter. Delete it (research_retract when this delegation wrote it).",
  "tack.assessment_shape": "An assessment Report carries `assessment` with execution / data / analysis / conclusion verdicts; research_assess writes one.",
};

/** Tack-convention findings, in molab's row shape. */
async function tackFindings(deps: ResearchDeps, signal: AbortSignal): Promise<ValidationRow[]> {
  const rows: ValidationRow[] = [];
  const add = (path: string, rule: string, detail: string, severity = "warning") => rows.push({ path, rule, detail, severity, hint: TACK_HINTS[rule] ?? "" });
  const { unreadable } = await deps.store.list(signal);
  for (const doc of unreadable) add(doc.path, "tack.delegation_unreadable", doc.error, "error");
  const docs = (await deps.molab.listDocs(signal)).filter((doc) => doc.cls === "Observation" || doc.cls === "Report");
  const records = await Promise.allSettled(docs.map((doc) => deps.molab.getRecord(doc.relPath, signal)));
  docs.forEach((doc, index) => {
    const settled = records[index]!;
    if (settled.status === "rejected") return;
    const record = settled.value.record;
    if (doc.cls === "Observation" && (record.decision !== undefined || record.answer !== undefined || record.capability_gap !== undefined)) {
      add(doc.relPath, "tack.decision_document", `an Observation holding ${record.decision !== undefined ? "a decision" : record.answer !== undefined ? "an answer" : "a capability gap"}`);
    }
    if (doc.cls === "Report" && record.assessment !== undefined) {
      const parsed = Assessment.safeParse(record.assessment);
      if (!parsed.success) add(doc.relPath, "tack.assessment_shape", z.prettifyError(parsed.error));
    }
  });
  return rows;
}

/** Group findings by rule, errors first, one hint per rule. */
export function renderFindings(rows: readonly ValidationRow[]): string {
  if (rows.length === 0) return "No format problems found.";
  const byRule = new Map<string, ValidationRow[]>();
  for (const row of rows) byRule.set(row.rule, [...(byRule.get(row.rule) ?? []), row]);
  const ordered = [...byRule.entries()].sort(([, a], [, b]) => Number(b[0]!.severity === "error") - Number(a[0]!.severity === "error"));
  return ordered
    .map(([rule, items]) =>
      [`${items[0]!.severity.toUpperCase()} ${rule} (${items.length})`, ...items.map((item) => `  - ${item.path}: ${item.detail}`), items[0]!.hint ? `  fix: ${items[0]!.hint}` : ""]
        .filter((line) => line !== "")
        .join("\n"),
    )
    .join("\n\n");
}

export function researchAudit(deps: ResearchDeps): ToolSpec<{ errorsOnly?: boolean }> {
  return {
    name: "research_audit",
    description: [
      "Check the served workspace's format, including work Tack did not write: molab's layout and knowledge rules",
      "(records, campaign links, missing experiments, sources outside the workspace, literature metadata, absolute paths),",
      "plus the conventions of Tack's own records. Read-only: it reports problems and how to fix them; it changes nothing.",
      "Run it when you first bind to an existing workspace, before planning on top of it.",
    ].join(" "),
    parameters: { errorsOnly: { type: "boolean", description: "Only problems that are errors." } },
    async execute(args, exec) {
      const [report, tack, docs] = await Promise.all([
        deps.molab.validate(args.errorsOnly === true, exec.signal),
        tackFindings(deps, exec.signal),
        deps.molab.listDocs(exec.signal),
      ]);
      const rows = [...report.violations, ...tack.filter((row) => !(args.errorsOnly === true && row.severity !== "error"))];
      const errors = rows.filter((row) => row.severity === "error").length;
      const campaign = await readCampaign(deps.molab, docs, exec.signal);
      const text = [
        `Audit of ${report.root}: ${errors} error(s), ${rows.length - errors} warning(s).`,
        renderFindings(rows),
        `Campaign as read:\n${renderCampaign(campaign)}`,
      ].join("\n\n");
      return { text, meta: { root: report.root, errors, warnings: rows.length - errors, findings: rows } };
    },
  };
}
