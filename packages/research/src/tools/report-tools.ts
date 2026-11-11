/**
 * Records that are not about one run: an analysis Report (a worker's
 * judgement, a literature reading, a structure check), and the removal of a
 * record written in error.
 *
 * A Report is Markdown that molab renders: its `molab:` refs become links in
 * molab's own views (an asset ref opens the asset, a structure in MolVis), so
 * a report never embeds a page served from this machine. A delegation keeps
 * one current report per host: a new one replaces the last, and the replaced
 * document is deleted (molab's history keeps it).
 */
import { forgetWrites, priorWrite, recordWrite, requireActive } from "../delegation/model.js";
import { isAssetRef } from "../molab/refs.js";
import { requireAction } from "../policy.js";
import { deleteDoc, hostOf, planCitation, writeCited } from "./records.js";
import { DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec } from "./types.js";

/** A link that only works on the machine that wrote it. */
const LOCAL_URL = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\b/i;
/** Markup that makes a body a page rather than Markdown. */
const HTML_PAGE = /<\s*(?:!doctype|html|head|body|iframe|script|style)\b/i;

/** The write-log key of the delegation's current report on `hostPath`. */
const reportKey = (hostPath: string): string => `report\n${hostPath}`;

interface ReportArgs {
  delegation: string;
  name: string;
  summary: string;
  body: string;
  evidence: string[];
  structures?: string[];
  host?: string;
}

/** Why a report cannot be written as given; undefined when it can. */
export function reportRefusal(args: Pick<ReportArgs, "summary" | "body" | "evidence" | "structures">): string | undefined {
  if (args.summary.trim() === "" || args.body.trim() === "") return "a report states its conclusion (summary) and its analysis (body)";
  if (!args.evidence.some((item) => item.startsWith("molab:"))) {
    return "a report cites at least one molab: ref in evidence (the asset, run or execution it rests on), so its trail leads back to registered results";
  }
  const structures = args.structures ?? [];
  const notAsset = structures.filter((ref) => !isAssetRef(ref));
  if (notAsset.length > 0) return `structures are molab:asset/<id> refs of the registered structure files (molab's MolVis opens them); not: ${notAsset.join(", ")}`;
  const texts = [args.summary, args.body, ...args.evidence, ...structures];
  const local = texts.find((text) => LOCAL_URL.test(text));
  if (local !== undefined) return `a report holds no link to this machine (localhost / 127.0.0.1): it is dead for every other reader. Cite the molab: ref of what it showed instead (found in: ${local.slice(0, 120)})`;
  if (texts.some((text) => HTML_PAGE.test(text))) return "a report is Markdown that molab renders, not an HTML page: no <html>, <iframe> or <script>";
  return undefined;
}

const cite = (item: string): string => (item.startsWith("molab:") ? `[${item}](${item})` : `\`${item}\``);

/** The Report's Markdown: conclusion first, then the structures, the analysis and the evidence. */
export function renderReport(args: Pick<ReportArgs, "name" | "summary" | "body" | "evidence" | "structures">, delegation: string): string {
  const structures = args.structures ?? [];
  return [
    `# ${args.name}`,
    "",
    args.summary.trim(),
    "",
    ...(structures.length > 0 ? ["## Structures", "", ...structures.map((ref) => `- ${cite(ref)}`), ""] : []),
    args.body.trim(),
    "",
    "## Evidence",
    "",
    ...args.evidence.map((item) => `- ${cite(item)}`),
    "",
    `Delegation: \`${delegation}\``,
    "",
  ].join("\n");
}

export function researchReport(deps: ResearchDeps): ToolSpec<ReportArgs> {
  return {
    name: "research_report",
    description: [
      "Record an analysis that is not about one run as a molab Report: a structure determination, a reading of the brief or the literature, a worker's plan or findings.",
      "The body is Markdown that molab renders. Cite what it rests on in evidence, at least one molab: ref (the asset, run or execution); knowledge documents and workspace files may follow.",
      "A report about a structure names the registered structure file in structures (molab:asset/<id>): molab opens it in MolVis. Never link a page served from this machine (localhost, 127.0.0.1) and never write HTML.",
      "One current report per host: a new report replaces this delegation's last one there, under a stable name (no date or version in it). Use research_assess instead for one run's evidence.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      name: { type: "string", required: true, description: "Report title. Stable: no date, version or round in it." },
      summary: { type: "string", required: true, description: "The conclusion in a few sentences. It is the first thing the report says." },
      body: { type: "string", required: true, description: "The analysis, in Markdown." },
      evidence: { type: "array", required: true, items: { type: "string" }, description: "molab: refs (at least one), knowledge document paths and workspace files it rests on." },
      structures: { type: "array", items: { type: "string" }, description: "molab:asset/<id> refs of the final structures the report is about; molab shows them in MolVis." },
      host: { type: "string", description: "Workspace-relative directory to file it under (default: the delegation's host)." },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(current.record);
      requireAction(current.record, "research_report");
      const refusal = reportRefusal(args);
      if (refusal !== undefined) throw new Error(refusal);
      const hostPath = args.host ?? hostOf(current.path);
      const key = reportKey(hostPath);
      const previous = priorWrite(current.record, key);
      const report = await writeCited(
        deps,
        { name: args.name, cls: "Report", hostPath, body: renderReport(args, current.path), record: { delegation: current.path, summary: args.summary, ...(args.structures?.length && { structures: args.structures }) } },
        [...args.evidence, ...(args.structures ?? []), ...planCitation(current.record), current.path],
        current.record.scope,
        "derived_from",
      );
      const replaced = previous !== undefined && previous !== report.relPath ? previous : undefined;
      if (replaced !== undefined) await deleteDoc(deps, replaced);
      const stored = await deps.store.update(
        current.path,
        (record) => recordWrite(replaced === undefined ? record : forgetWrites(record, replaced), key, report.relPath),
        () => ({ evidence: [report.relPath] }),
      );
      return {
        text: `Recorded report ${report.relPath}${replaced !== undefined ? `; it replaces ${replaced}, now deleted` : previous === report.relPath ? " (rewritten in place)" : ""}.`,
        meta: { report, ...(replaced !== undefined && { replaced }), delegation: stored.path },
      };
    },
  };
}

interface RetractArgs {
  delegation: string;
  path: string;
  reason: string;
}

export function researchRetract(deps: ResearchDeps): ToolSpec<RetractArgs> {
  return {
    name: "research_retract",
    description:
      "Delete a record this delegation wrote in error (a duplicate, a wrong report or plan): the document is removed from the workspace, and molab's history keeps what it said and why it went. Write the correct record before or after; do not keep the wrong one beside it.",
    parameters: {
      ...DELEGATION_PARAM,
      path: { type: "string", required: true, description: "Knowledge document to delete." },
      reason: { type: "string", required: true },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireAction(current.record, "research_retract");
      if (args.reason.trim() === "") throw new Error("say why the record is retracted");
      const target = await deps.molab.getRecord(args.path, exec.signal);
      if (target.record.delegation !== current.path) throw new Error(`${args.path} was not written by this delegation; it is not yours to retract`);
      await deleteDoc(deps, args.path);
      await deps.store.update(
        current.path,
        (record) => {
          const forgotten = forgetWrites(record, args.path);
          return forgotten.current_plan === args.path ? { ...forgotten, current_plan: undefined } : forgotten;
        },
        () => ({ next: `retracted ${args.path}: ${args.reason.trim()}` }),
      );
      return { text: `Deleted ${args.path}. Reason: ${args.reason}` };
    },
  };
}
