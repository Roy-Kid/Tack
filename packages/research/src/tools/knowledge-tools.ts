/**
 * The research record as molab knowledge:
 * - a plan is a `Plan` (see `plan-tool.ts`), revised in place under its stable name;
 * - an evidence judgement is a `Report` carrying an `assessment` record;
 * - a decision is an entry of its Delegation's `decisions` log;
 * - an analysis that is not about one run is a `Report` (research_report);
 * - a conclusion is a `Finding`.
 * Every document cites its sources, so the trail from conclusion back to runs
 * is a graph molab can walk, export and version.
 */
import { block, type DelegationRecord, GATES, type GateRef, markGate, recordDecision, requireActive, requireApproved, transition } from "../delegation/model.js";
import { type CapabilityGap, COMPONENTS, type Level, verdictsFrom, type WorkerReport } from "../delegation/report.js";
import { linkReportDoc, settledLinks } from "../delegation/reports.js";
import { parseRef } from "../molab/refs.js";
import { requireAction } from "../policy.js";
import { clip } from "../text.js";
import { DECISIONS, type DecisionKind, fileCapabilityGaps } from "./decisions.js";
import { contentKey, docName, hostOf, planCitation, writeCited, writeOnce } from "./records.js";
import { DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec } from "./types.js";

export { DECISIONS } from "./decisions.js";

/** The document kind `research_assess` writes; its name starts with it (`docName`). */
const ASSESSMENT_KIND = "assessment";
const ASSESSMENT_PATH = new RegExp(`(^|/)${ASSESSMENT_KIND}-[^/]*\\.md$`);

/** The latest assessment Report this delegation wrote: what a person approves before a conclusion (gate results). */
export function latestAssessment(record: DelegationRecord): string | undefined {
  return [...record.writes].reverse().find((write) => ASSESSMENT_PATH.test(write.path))?.path;
}

const VERDICT = { type: "string", required: true, enum: ["pass", "fail", "unknown"] } as const;
const LEVEL_SHAPE = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: VERDICT, reason: { type: "string", required: true } },
} as const;
const LEVEL = { ...LEVEL_SHAPE, required: true } as const;
/** A level the report prefills when it is not given (DSH's DSL spells optional by omitting `required`). */
const PREFILLED_LEVEL = { ...LEVEL_SHAPE, description: "Prefilled from the worker's report when report is given and this is omitted." } as const;

interface AssessArgs {
  delegation: string;
  target?: string;
  project?: string;
  name: string;
  execution?: Level;
  data?: Level;
  analysis: Level;
  conclusion: Level;
  evidence: string[];
  report?: string;
}

export function researchAssess(deps: ResearchDeps): ToolSpec<AssessArgs> {
  return {
    name: "research_assess",
    description: [
      "Record an evidence judgement for one run or worker attempt as a molab Report, at four separate levels:",
      "execution (did it finish; what did the platform report), data (complete products, correct units, structure, sampling and conditions),",
      "analysis (are the method and metric valid for this data), conclusion (is the evidence sufficient, and for what range).",
      "A clean exit with invalid data is execution pass, data fail. Run programmatic validators first and cite their outputs as evidence.",
      "For a worker attempt give report (the worker's Report path from research_status): execution and data are prefilled from its outcome and checks unless you give them, the report and its products become evidence, and the report is linked to its attempt. Read the attempt's outputs only when the report is missing, invalid or contradicts the acceptance criteria.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      target: { type: "string", description: "molab: ref of the run or execution assessed (required unless report is given)." },
      project: { type: "string", description: "Project id of the target ('-' when molab serves that project or below); required with target." },
      name: { type: "string", required: true, description: "Report title." },
      execution: PREFILLED_LEVEL,
      data: PREFILLED_LEVEL,
      analysis: LEVEL,
      conclusion: LEVEL,
      evidence: { type: "array", required: true, items: { type: "string" }, description: "molab: refs, knowledge document paths, and workspace files (e.g. a worker's product) the judgement rests on." },
      report: { type: "string", description: "Path of the worker's Report (record kind worker_report) this judgement is about." },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(current.record);
      requireAction(current.record, "research_assess");
      if (args.target === undefined && args.report === undefined) throw new Error("assess a run (target and project) or a worker attempt (report)");
      let worker: { attempt: string; report: WorkerReport } | undefined;
      if (args.report !== undefined) {
        await settledLinks(deps, current.path);
        const linked = await linkReportDoc(deps, current.path, args.report, exec.signal);
        worker = { attempt: linked.attempt.id, report: linked.report };
      }
      let hostPath = hostOf(current.path);
      if (args.target !== undefined) {
        const ref = parseRef(args.target);
        if (ref.run === undefined) throw new Error("assess a run or an attempt (a molab: run or execution ref)");
        if (args.project === undefined) throw new Error("target needs its project id ('-' when molab serves that project or below)");
        hostPath = (await deps.molab.getRun({ project: args.project, experiment: ref.experiment!, run: ref.run }, exec.signal)).path;
      }
      const prefilled = worker === undefined ? undefined : verdictsFrom(worker.report);
      const execution = args.execution ?? prefilled?.execution;
      const data = args.data ?? prefilled?.data;
      if (execution === undefined || data === undefined) throw new Error("give the execution and data verdicts (they are prefilled only from a worker's report)");
      const levels = { execution, data, analysis: args.analysis, conclusion: args.conclusion };
      const evidence = [...new Set([...(args.report !== undefined ? [args.report] : []), ...args.evidence])];
      const subject = [args.target, worker === undefined ? undefined : `attempt ${worker.attempt} (${args.report})`].filter(Boolean).join(" · ");
      const rows = Object.entries(levels).map(([level, value]) => `| ${level} | ${value.verdict} | ${value.reason.replace(/\|/g, "\\|")} |`);
      const body = [
        `# ${args.name}`,
        "",
        `Assessed: ${subject} · Delegation: ${current.path}`,
        "",
        "| level | verdict | reason |",
        "| --- | --- | --- |",
        ...rows,
        "",
        "## Evidence",
        "",
        ...evidence.map((item) => `- ${item}`),
        ...(worker !== undefined && worker.report.products.length > 0 ? ["", "## Products (from the report)", "", ...worker.report.products.map((product) => `- ${product.path} (${product.kind})${product.description ? `: ${product.description}` : ""}`)] : []),
        "",
      ].join("\n");
      const subjectKey = args.target ?? args.report!;
      const report = await writeOnce(deps, current.path, contentKey("assessment", subjectKey, levels, evidence), () =>
        writeCited(
          deps,
          {
            name: docName(ASSESSMENT_KIND, args.name, deps.now()),
            cls: "Report",
            hostPath,
            body,
            record: {
              delegation: current.path,
              ...(args.target !== undefined && { target: args.target }),
              ...(worker !== undefined && { attempt: worker.attempt, report: args.report }),
              assessment: levels,
            },
          },
          [...(args.target !== undefined ? [args.target] : []), ...evidence, ...planCitation(current.record), current.path],
          args.target ?? current.record.scope,
          "derived_from",
        ),
      );
      await deps.store.update(current.path, report.remember);
      const failed = Object.entries(levels).filter(([, value]) => value.verdict === "fail").map(([level]) => level);
      const next = deps.config.gates.results
        ? `Next: a person approves these results before a conclusion (research_decide ask_human, gate results, target ${report.relPath}, quoting the verdicts); otherwise research_decide.`
        : "Next: research_decide.";
      return {
        text: `${report.reused ? "Already recorded" : "Recorded"} assessment ${report.relPath}: ${failed.length === 0 ? "no level failed" : `failed at ${failed.join(", ")}`}. ${next}`,
        meta: { report: { relPath: report.relPath, reused: report.reused }, assessment: levels, ...(worker !== undefined && { attempt: worker.attempt }) },
      };
    },
  };
}

interface DecideArgs {
  delegation: string;
  name: string;
  decision: DecisionKind;
  reason: string;
  evidence: string[];
  next?: string;
  questions?: string[];
  gate?: GateRef;
  finding?: { name: string; statement: string; scope: string; host: string };
  gap?: Partial<CapabilityGap> & { component: CapabilityGap["component"]; repro: string };
}

/** How much of a decision's reason the delegation's log keeps. */
const REASON_CHARS = 1000;

export function researchDecide(deps: ResearchDeps): ToolSpec<DecideArgs> {
  return {
    name: "research_decide",
    description: [
      "Record a decision and its evidence in the delegation's decision log, so later agents know why a route was taken or dropped. A decision is not a document of its own.",
      "add_run: more runs under the same design. new_experiment: a changed hypothesis or design. fix: repair a computation or analysis. continue: proceed as planned.",
      "conclude: the acceptance criteria are met; give finding (statement and its range of validity) and the delegation closes.",
      "ask_human: the next step needs a person (an answer, a decision, more budget or authority); give the questions — the delegation is blocked, not ended, and research_resume continues it once they answer.",
      "A gate question (the uncertain parameters, the plan, a dry run, the results) also names gate {gate, target} so their approval can be recorded against that target; the questions carry the marker, and the run's output tells the calling agent what to answer.",
      "conclude is refused until a person approved the latest assessment (gate results).",
      "stop_route: this route is ruled out. stop: end the delegation for good (the question is settled negatively, or it is no longer worth pursuing). Do not stop to wait for a person.",
      "capability_gap: a tool is missing or keeps failing; give gap (component, the steps that reproduce it, the version). A science tool's gap becomes an item of the workspace's one capability-gaps Todo; a gap in molab, DSH or Tack is not written to the workspace and is reported back to you. Finding no improvement is a valid conclusion.",
      "conclude and stop close the delegation and end all writes on it, and are refused while a worker attempt has not ended. Closing is the last call: record every assessment, report (research_report) and capability gap first.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      name: { type: "string", required: true, description: "Decision title." },
      decision: { type: "string", required: true, enum: [...DECISIONS] },
      reason: { type: "string", required: true },
      evidence: { type: "array", required: true, items: { type: "string" }, description: "Report paths, molab: refs, and workspace files the decision rests on." },
      next: { type: "string", description: "The next step this decision commits to." },
      questions: { type: "array", items: { type: "string" }, description: "Required for ask_human: each question the person must answer." },
      gate: {
        type: "object",
        description: "With ask_human: the gate this question opens and its target (parameters: the delegation path; plan: the Plan path; dry_run: the workflow or experiment path; results: the assessment Report path).",
        additionalProperties: false,
        properties: {
          gate: { type: "string", required: true, enum: [...GATES] },
          target: { type: "string", required: true },
        },
      },
      finding: {
        type: "object",
        description: "Required for conclude.",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          statement: { type: "string", required: true, description: "The conclusion." },
          scope: { type: "string", required: true, description: "The conditions it holds under (model, parameters, protocol)." },
          host: { type: "string", required: true, description: "Workspace-relative directory of the experiment it belongs to." },
        },
      },
      gap: {
        type: "object",
        description: "Required for capability_gap: the structured gap.",
        additionalProperties: false,
        properties: {
          component: { type: "string", required: true, enum: [...COMPONENTS] },
          title: { type: "string", description: "Defaults to the decision title." },
          repro: { type: "string", required: true, description: "The exact steps that reproduce it." },
          version: { type: "string" },
          fix: { type: "string", description: "What would fix it, when known." },
        },
      },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(current.record);
      requireAction(current.record, "research_decide");
      if (args.evidence.length === 0) throw new Error("a decision cites the evidence it rests on");
      if (args.decision === "conclude" && args.finding === undefined) throw new Error("conclude needs a finding: the statement and the conditions it holds under");
      if (args.decision === "ask_human" && (args.questions ?? []).length === 0) throw new Error("ask_human needs the questions the person must answer");
      if (args.decision === "capability_gap" && args.gap === undefined) throw new Error("capability_gap names its component and the steps that reproduce it (gap)");
      if (args.gate !== undefined && args.decision !== "ask_human") throw new Error("gate goes with ask_human: it names what the person's answer approves");
      const closing = args.decision === "conclude" ? "done" : args.decision === "stop" ? "stopped" : undefined;
      if (closing !== undefined) {
        const open = current.record.attempts.filter((attempt) => attempt.ended_at === undefined || attempt.ended_at === null);
        if (open.length > 0) {
          throw new Error(
            `cannot ${args.decision} while worker attempt${open.length === 1 ? "" : "s"} ${open.map((attempt) => attempt.id).join(", ")} ${open.length === 1 ? "has" : "have"} not ended: wait for the settlement (research_status shows it), assess the report, then close.`,
          );
        }
      }
      // Gate results: a conclusion rests on an assessment a person approved.
      if (args.decision === "conclude" && deps.config.gates.results) {
        const latest = latestAssessment(current.record);
        if (latest === undefined) {
          throw new Error("conclude needs an assessment a person approved: research_assess first, then ask them (research_decide ask_human, gate results) and record their answer with research_resume approve");
        }
        requireApproved(current.record, "results", latest);
      }
      const questions = args.gate === undefined ? (args.questions ?? []) : markGate(args.gate, args.questions ?? []);
      const gap: CapabilityGap | undefined = args.gap === undefined ? undefined : { ...args.gap, title: args.gap.title ?? args.name };
      const filed = gap === undefined ? undefined : await fileCapabilityGaps(deps, [gap], current.path, current.record.scope);
      let finding: { relPath: string } | undefined;
      if (args.decision === "conclude" && args.finding !== undefined) {
        const latest = latestAssessment(current.record);
        const assessed = latest === undefined ? [] : [latest];
        finding = await writeCited(
          deps,
          {
            name: args.finding.name,
            cls: "Finding",
            hostPath: args.finding.host,
            body: [`# ${args.finding.name}`, "", args.finding.statement, "", "## Holds under", "", args.finding.scope, "", `Concluded in ${current.path}.`, ""].join("\n"),
            record: { delegation: current.path, holds_under: args.finding.scope },
          },
          // A finding rests on its evidence, on the assessment that judged it and on the plan it answers.
          [...args.evidence, ...assessed, ...planCitation(current.record), current.path],
          current.record.scope,
          "derived_from",
        );
      }
      const decision = {
        at: deps.now().toISOString(),
        name: args.name,
        kind: args.decision,
        reason: clip(args.reason.trim(), REASON_CHARS),
        evidence: [...args.evidence, ...(filed?.todo !== undefined ? [filed.todo] : []), ...(finding !== undefined ? [finding.relPath] : [])],
        ...(args.next !== undefined && { next: clip(args.next, 300) }),
        questions,
      };
      const stored = await deps.store.update(
        current.path,
        (record) => {
          const decided = recordDecision(record, decision);
          return args.decision === "ask_human" ? block(decided, questions) : closing === undefined ? decided : transition(decided, closing);
        },
        () => ({ next: args.next ?? (closing !== undefined ? "closed" : "act on the decision"), evidence: decision.evidence }),
      );
      const blocked =
        stored.record.state === "blocked"
          ? ` End your turn: the person's answer arrives as the next prompt; record it with research_resume${args.gate !== undefined ? ` (approve: {gate: "${args.gate.gate}", target: "${args.gate.target}"} only if they approved it)` : ""}.`
          : "";
      const gapNote =
        filed === undefined ? "" : filed.todo !== undefined ? `; the gap is an item of ${filed.todo}` : `; this is a harness gap (${gap!.component}): it is not written to the workspace — report it to the person or the tool's maintainers`;
      return {
        text: `Recorded decision ${args.decision} on ${current.path}${gapNote}${finding !== undefined ? `; finding ${finding.relPath}` : ""}. Delegation is ${stored.record.state}.${blocked}`,
        meta: { decision, finding, gaps: filed, delegation: stored },
      };
    },
  };
}
