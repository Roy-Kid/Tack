/**
 * `research_dispatch`: the one way a supervising session starts a worker.
 * It compiles an immutable brief from the delegation (goal, plan, what people
 * answered, earlier attempts' reports, protocol, workspace rules, the report
 * contract), keeps it as a molab Note, starts the worker on the runtime's
 * subagent service, charges and records the attempt, and files the worker's
 * report when the result arrives. DSH delivers the settlement to the
 * supervisor; the supervisor then assesses from the report.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { type BriefMode, type BriefProtocol, compileBrief, currentWorkflow, type EarlierAttempt } from "../brief.js";
import { coveringApproval, requireActive, requireApproved, toWire } from "../delegation/model.js";
import { WORKER_REPORT_SCHEMA, WorkerReport } from "../delegation/report.js";
import { linkWorkerReport, trackLink } from "../delegation/reports.js";
import { requireAction } from "../policy.js";
import { clip, errorMessage } from "../text.js";
import { workerRefusal } from "../workers.js";
import { contentKey, docName, hostOf, writeOnce } from "./records.js";
import { DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec, type WorkerKind } from "./types.js";

const LABEL_CHARS = 80;
const ATTACHMENT_BYTES = 64 * 1024;

export interface DispatchArgs {
  delegation: string;
  worker: string;
  description: string;
  task: string;
  expected: string[];
  protocol?: BriefProtocol;
  attachments?: string[];
  continue?: string;
  mode?: BriefMode;
  workflow?: string;
}

const PROTOCOL_PARAM = {
  type: "object",
  additionalProperties: false,
  description: "What the worker must hold fixed; every departure is a protocol deviation in its report.",
  properties: {
    reproduce: { type: "string", description: "An execution ref (molab:…/execution/…) to reproduce exactly." },
    realization: { type: "string", enum: ["independent"], description: "An independent realization instead of a reproduction." },
    seed: { type: "integer" },
    stereo: { type: "string", description: "Stereochemistry policy." },
    charges: { type: "string", description: "Charge neutralization policy." },
    notes: { type: "string" },
  },
} as const;

/** The child id behind an attempt id (`<child>` or `<child>:r<n>` for a continuation round). */
export function childOf(attemptId: string): string {
  return attemptId.replace(/:r\d+$/, "");
}

/** A workspace file's text for the brief; the path stays inside the served root. */
async function readAttachment(root: string, path: string): Promise<{ path: string; text: string }> {
  const base = resolve(root);
  const file = resolve(base, path);
  if (file !== base && !file.startsWith(`${base}${sep}`)) throw new Error(`attachment ${path} is outside the served workspace`);
  try {
    const text = await readFile(file, "utf8");
    return { path, text: text.length > ATTACHMENT_BYTES ? `${text.slice(0, ATTACHMENT_BYTES)}\n… (cut at ${ATTACHMENT_BYTES} characters)` : text };
  } catch (error) {
    throw new Error(`cannot read attachment ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Earlier attempts with the reports they were linked to; an unreadable report is left out, not fatal. */
async function earlierAttempts(deps: ResearchDeps, attempts: readonly EarlierAttempt["attempt"][], signal: AbortSignal): Promise<EarlierAttempt[]> {
  return Promise.all(
    attempts.map(async (attempt) => {
      if (attempt.report === undefined || attempt.report === null) return { attempt };
      try {
        const doc = await deps.molab.getRecord(attempt.report, signal);
        const parsed = WorkerReport.safeParse(doc.record);
        return parsed.success ? { attempt, report: parsed.data } : { attempt };
      } catch (error) {
        deps.logger.warn(`tack-research: report ${attempt.report} of attempt ${attempt.id} cannot be read for the brief: ${errorMessage(error)}`);
        return { attempt };
      }
    }),
  );
}

function kindOf(deps: ResearchDeps, name: string): WorkerKind {
  const kinds = deps.workers.kinds();
  const kind = kinds.find((candidate) => candidate.name === name);
  if (kind === undefined) {
    throw new Error(`no worker provider "${name}"; registered: ${kinds.length === 0 ? "(none yet)" : kinds.map((candidate) => candidate.name).join(", ")}`);
  }
  return kind;
}

export function researchDispatch(deps: ResearchDeps): ToolSpec<DispatchArgs> {
  return {
    name: "research_dispatch",
    description: [
      "Start one worker round on the delegation. Tack compiles the brief (goal, acceptance, plan, what people answered, the last decision, earlier attempts with their reports, the protocol, the workspace rules and the report contract), keeps it as a molab Note, starts the worker, and charges one worker run.",
      "Give the task for this round and the expected products; do not probe the workspace first, the brief carries what the worker needs. Then end your turn: DSH wakes you with the worker's settlement, and the worker's report is filed as a Report linked to the attempt.",
      "When woken, call research_status to see the attempt's report path, then research_assess(report: <path>); read outputs only if the report is missing, invalid or contradicts the acceptance criteria.",
      "worker: a registered provider — spawn (in-process DeepSeek, has the molab_* tools), fork, claude-code, codex. continue: the attempt id of a spawn or fork worker started in this session, to give it the next round instead of starting a new worker.",
      "Two gates apply: a person must have approved the current plan (gate plan), and mode run needs their approval of the workflow's dry run (gate dry_run). Until then the round is a draft: the worker writes the workflow, dry-runs it and reports the waves; it cannot execute.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      worker: { type: "string", required: true, description: "Worker provider name (spawn, fork, claude-code, codex); the error names the registered ones." },
      description: { type: "string", required: true, description: "Short label for the attempt (under 80 characters)." },
      task: { type: "string", required: true, description: "What the worker must do this round, concretely. The brief adds everything else." },
      expected: { type: "array", required: true, items: { type: "string" }, description: "Products the worker must deliver, each by name or path; the worker reports a check for each." },
      protocol: PROTOCOL_PARAM,
      attachments: { type: "array", items: { type: "string" }, description: "Workspace-relative files whose text goes into the brief verbatim (small files: a structure, a table, a script)." },
      continue: { type: "string", description: "Attempt id to continue (spawn/fork workers of this session only)." },
      mode: {
        type: "string",
        enum: ["draft", "run"],
        description: "draft: the worker writes the workflow and dry-runs it, executing nothing (the default until a person approves the dry run). run: execute the approved workflow; needs the dry_run approval of its workflow or experiment.",
      },
      workflow: { type: "string", description: "For mode run: the workflow (or experiment) path whose dry run the person approved; defaults to the workflow the latest report names." },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(current.record);
      requireAction(current.record, "research_dispatch");
      if (args.task.trim() === "") throw new Error("say what the worker must do this round (task)");
      if (args.expected.length === 0) throw new Error("name at least one expected product (expected)");
      const continued = args.continue === undefined ? undefined : current.record.attempts.find((attempt) => attempt.id === args.continue);
      if (args.continue !== undefined && continued === undefined) throw new Error(`no attempt ${args.continue} on ${current.path} to continue`);
      const kind = kindOf(deps, continued?.worker ?? args.worker);
      if (continued !== undefined && (!kind.continuable || deps.workers.continue === undefined)) {
        throw new Error(`attempt ${continued.id} ran on ${kind.name}, which takes no further messages; start a new attempt instead`);
      }
      const gates = deps.config.gates;
      const problem = workerRefusal(current.record, current.path, deps.ledger.inFlight(current.path), gates);
      if (problem !== undefined) throw new Error(`Not started: ${problem}`);

      const root = await deps.molab.root(exec.signal);
      const [plan, attempts, attachments] = await Promise.all([
        current.record.current_plan ? deps.molab.readDoc(current.record.current_plan, exec.signal).then((doc) => ({ path: doc.relPath, body: doc.body })) : Promise.resolve(undefined),
        earlierAttempts(deps, current.record.attempts, exec.signal),
        Promise.all((args.attachments ?? []).map((path) => readAttachment(root, path))),
      ]);
      // Gate dry_run: a run round rests on a person's approval of the workflow's dry run; until then the round is a draft.
      const workflow = args.workflow ?? currentWorkflow(attempts);
      const approval = workflow === undefined ? undefined : coveringApproval(current.record, "dry_run", workflow);
      const mode: BriefMode = args.mode ?? (gates.dryRun && approval === undefined ? "draft" : "run");
      if (mode === "run" && gates.dryRun) {
        if (workflow === undefined) throw new Error("Not started: mode run needs the workflow whose dry run a person approved: give workflow (the path the draft round reported), or dispatch a draft round first.");
        if (approval === undefined) requireApproved(current.record, "dry_run", workflow);
      }
      const round = current.record.attempts.length + 1;
      const brief = compileBrief({
        delegation: current.path,
        record: current.record,
        round,
        worker: kind.name,
        mode,
        ...(mode === "run" && approval !== undefined && { approval: { target: approval.target, by: approval.by, at: approval.at } }),
        inProcess: kind.inProcess,
        structured: kind.structured && continued === undefined,
        cwd: root,
        task: args.task,
        expected: args.expected,
        protocol: args.protocol ?? {},
        ...(plan !== undefined && { plan }),
        attempts,
        attachments,
        ...(continued !== undefined && { continues: continued.id }),
      });
      const afterwards =
        mode === "draft"
          ? "This is a draft round: the worker writes and dry-runs the workflow without executing. When it reports, call molab_dry_run on the experiment and ask the person to approve the dry run (research_decide ask_human, gate dry_run) before a run round."
          : "";
      const note = await writeOnce(deps, current.path, contentKey("brief", args.task, round), () =>
        deps.molab.createDoc({
          name: docName("brief", `${current.name} round ${round} ${args.description}`, deps.now()),
          cls: "Note",
          hostPath: hostOf(current.path),
          body: brief.body,
          sources: [],
          record: toWire(brief.record),
          createdBy: deps.config.createdBy,
        }),
      );

      const call = {};
      deps.ledger.hold(current.path, call);
      const label = clip(args.description.trim(), LABEL_CHARS);
      try {
        if (continued !== undefined) {
          const childId = childOf(continued.id);
          const rounds = current.record.attempts.filter((attempt) => childOf(attempt.id) === childId).length;
          const attemptId = `${childId}:r${rounds + 1}`;
          await deps.workers.continue!(childId, brief.body, exec.sessionId, exec.signal);
          await deps.ledger.started(call, {
            delegation: current.path,
            subagentId: childId,
            attemptId,
            worker: kind.name,
            task: args.description,
            brief: note.relPath,
            brief_digest: brief.digest,
            remember: note.remember,
            linkOnEnd: true,
            ...(exec.sessionId !== undefined && { parentSessionId: exec.sessionId }),
          });
          return {
            text: [
              `Continued worker ${childId} as attempt ${attemptId} (round ${round}, mode ${mode}) with brief ${note.relPath}. End your turn: its reply wakes you, and its report (the last \`\`\`json block) is filed to the attempt. Then research_status, research_assess(report: <path>).`,
              afterwards,
            ].join(" "),
            meta: { attempt: attemptId, brief: note.relPath, digest: brief.digest, continued: continued.id, mode },
          };
        }
        const started = await deps.workers.start({
          provider: kind.name,
          label,
          cwd: root,
          prompt: brief.body,
          ...(kind.structured && { outputSchema: WORKER_REPORT_SCHEMA as unknown as Record<string, unknown> }),
          ...(exec.sessionId !== undefined && { parentSessionId: exec.sessionId }),
          signal: exec.signal,
        });
        // File the report when the result arrives; a reader (research_status, research_assess) can wait for a filing in progress,
        // and the ledger hears whether it was linked when the child's end settles the attempt.
        const reported = trackLink(deps, current.path, started.result, (outcome) => linkWorkerReport(deps, current.path, started.id, outcome)).then(
          (result) => result.linked,
          (error: unknown) => {
            deps.logger.warn(`tack-research: the report of attempt ${started.id} on ${current.path} was not filed: ${errorMessage(error)}`);
            return undefined;
          },
        );
        await deps.ledger.started(call, {
          delegation: current.path,
          subagentId: started.id,
          worker: kind.name,
          task: args.description,
          brief: note.relPath,
          brief_digest: brief.digest,
          remember: note.remember,
          ...(exec.sessionId !== undefined && { parentSessionId: exec.sessionId }),
          reported,
        });
        return {
          text: [
            `Started attempt ${started.id} (${kind.name}, round ${round}, mode ${mode}) on ${current.path}; brief ${note.relPath} (sha256 ${brief.digest.slice(0, 12)}…).`,
            "End your turn now: DSH wakes you with the worker's settlement, and its report is filed as a Report linked to the attempt.",
            "Then research_status(delegation) names the report path; research_assess(report: <path>) judges it. Read outputs only if the report is missing, invalid or contradicts the acceptance criteria.",
            afterwards,
          ].join(" "),
          meta: { attempt: started.id, brief: note.relPath, digest: brief.digest, worker: kind.name, structured: kind.structured, mode },
        };
      } catch (error) {
        deps.ledger.release(call);
        throw error;
      }
    },
  };
}
