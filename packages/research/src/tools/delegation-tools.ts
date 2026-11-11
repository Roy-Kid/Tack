/**
 * Open, inspect, pause and park a delegation. The delegation document in
 * molab is the only state; each tool reads it, computes the next record, and
 * writes it back.
 */
import { type Action, ACTIONS, approve, type Budget, DelegationRecord, type Gate, GATES, pendingWaits, recordAnswer, resume, transition } from "../delegation/model.js";
import { settledLinks } from "../delegation/reports.js";
import { foldSettled, reconcile, resumeBrief } from "../reconcile.js";
import { requireSubset } from "../policy.js";
import { clip } from "../text.js";
import { boundScope, hostPathOf } from "./scope.js";
import { DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec } from "./types.js";

interface OpenArgs {
  name: string;
  goal: string;
  scope?: string;
  project?: string;
  actions: Action[];
  budget?: Budget;
  acceptance?: string[];
  stop_conditions?: string[];
  kind?: "research" | "capability";
  parent?: string;
  plan?: string;
}

export function researchOpen(deps: ResearchDeps): ToolSpec<OpenArgs> {
  return {
    name: "research_open",
    description: [
      "Open a research delegation: one bounded, resumable piece of work bound to a molab scope, stored as a Delegation knowledge document.",
      "Ask the user only for constraints that change what you would do: the question, which variables may change, the metric, the compute and worker budget, which actions are authorized, and when to stop.",
      "Stop conditions should include more than success: evidence that rules a route out, budget exhausted, missing decisive data, repeated attempts with no new information, or a need for resources outside the scope.",
    ].join("\n"),
    parameters: {
      name: { type: "string", required: true, description: "Short human title; it becomes the document name." },
      goal: { type: "string", required: true, description: "The question this delegation answers." },
      scope: { type: "string", description: "molab: ref of the project, experiment or run it is bound to. Defaults to the node molab serves." },
      project: { type: "string", description: "Project id, when scope is an experiment or run under a served workspace or project." },
      actions: {
        type: "array",
        required: true,
        items: { type: "string", enum: [...ACTIONS] },
        description: "Actions the delegation may take on its own.",
      },
      budget: {
        type: "object",
        description: "Limits; omit a line for unlimited.",
        additionalProperties: false,
        properties: {
          worker_usd: { type: "number" },
          worker_runs: { type: "integer" },
          executions: { type: "integer" },
          wall_hours: { type: "number" },
        },
      },
      acceptance: { type: "array", items: { type: "string" }, description: "What must hold for the work to count as done." },
      stop_conditions: { type: "array", items: { type: "string" }, description: "When to stop, including non-success endings." },
      kind: { type: "string", enum: ["research", "capability"], description: "research (default) or capability improvement." },
      parent: { type: "string", description: "Path of a parent delegation; this one may hold no action the parent lacks." },
      plan: { type: "string", description: "Path of an existing Plan (written by anyone) this delegation works under; it becomes the current plan." },
    },
    async execute(args, exec) {
      const served = await boundScope(deps.molab, exec.signal);
      const scope = args.scope ?? served.ref;
      if (scope === undefined) throw new Error("molab serves a whole workspace; name the project, experiment or run this delegation is bound to (scope)");
      if (args.parent !== undefined) requireSubset((await loadDelegation(deps, args.parent, exec.signal)).record.actions, args.actions);
      if (args.plan !== undefined) {
        const plan = await deps.molab.getRecord(args.plan, exec.signal);
        if (plan.cls !== "Plan") throw new Error(`${args.plan} is a ${plan.cls}, not a Plan`);
      }
      const record = DelegationRecord.parse({
        kind: args.kind ?? "research",
        goal: args.goal,
        scope,
        actions: args.actions,
        budget: args.budget ?? {},
        acceptance: args.acceptance ?? [],
        stop_conditions: args.stop_conditions ?? [],
        ...(args.plan !== undefined && { current_plan: args.plan }),
        supervisor: exec.sessionId === undefined ? {} : { session_id: exec.sessionId, ...(args.parent !== undefined && { parent: args.parent }) },
      });
      const hostPath = await hostPathOf(deps.molab, served, scope, args.project, exec.signal);
      const next = args.plan !== undefined ? "work through the plan's open todo items" : "write the first plan (research_plan)";
      const stored = await deps.store.create({ name: args.name, hostPath, record, extras: { next } });
      exec.focus?.(stored.path);
      return {
        text: `Opened delegation ${stored.path} bound to ${scope}. Authorized: ${record.actions.join(", ")}. Next: read the existing state (research_context), then write a plan (research_plan).`,
        meta: stored,
      };
    },
  };
}

export function researchStatus(deps: ResearchDeps): ToolSpec<{ delegation?: string }> {
  return {
    name: "research_status",
    description:
      "Without a delegation: list every delegation in the served scope and its state. With one: check its waits against molab now (recording anything that finished) and report goal, acceptance, plan, last decision, answers, waits, worker attempts with their report paths, and budget.",
    parameters: { delegation: { type: "string", description: "Delegation document path; omit to list all." } },
    async execute(args, exec) {
      if (args.delegation === undefined) {
        const { delegations, unreadable } = await deps.store.list(exec.signal);
        const rows = delegations.map((item) => `- ${item.path}: ${item.record.state} — ${item.record.goal} (${pendingWaits(item.record).length} waiting)`);
        const bad = unreadable.map((doc) => `- ${doc.path}: cannot be read (${doc.error}); see research_audit`);
        if (rows.length === 0 && bad.length === 0) return { text: "No delegations in this scope yet. Open one with research_open.", meta: [] };
        return {
          text: [...rows, ...bad].join("\n"),
          meta: { delegations: delegations.map(({ path, record }) => ({ path, state: record.state, goal: record.goal })), unreadable },
        };
      }
      // A worker's report may still be on its way into molab when its settlement wakes the supervisor.
      await settledLinks(deps, args.delegation.trim());
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      const reconciled = await reconcile(deps.molab, current.record, deps.now(), exec.signal);
      const stored = reconciled.changed ? await deps.store.update(current.path, (record) => foldSettled(record, reconciled.record)) : current;
      return { text: resumeBrief(stored.path, { ...reconciled, record: stored.record }), meta: stored };
    },
  };
}

export function researchPause(deps: ResearchDeps): ToolSpec<{ delegation: string; resume?: boolean }> {
  return {
    name: "research_pause",
    description:
      "Pause supervision of a delegation (no new steps, no wake-ups), or resume it. This does not stop a running worker or cancel molab compute: use molab_cancel_execution for compute.",
    parameters: { ...DELEGATION_PARAM, resume: { type: "boolean", description: "true to resume a paused delegation." } },
    async execute(args, exec) {
      const stored = await deps.store.update(args.delegation, (record) => {
        const next = args.resume === true ? resume(record) : transition(record, "paused");
        return args.resume === true && exec.wakeSupervisor === true ? { ...next, supervisor: { ...next.supervisor, wake: "pending" } } : next;
      },
        undefined,
        exec.expectedDigest,
      );
      return { text: `Delegation ${stored.path} is now ${stored.record.state}. Compute already submitted keeps running.`, meta: stored };
    },
  };
}

export function researchWait(deps: ResearchDeps): ToolSpec<{ delegation: string; next: string }> {
  return {
    name: "research_wait",
    description:
      "Park the delegation until its pending waits settle (started with molab_start_execution), and end this turn. Tack checks molab in the background and wakes this session with a brief when something finishes. Use it instead of polling.",
    parameters: {
      ...DELEGATION_PARAM,
      next: { type: "string", required: true, description: "What you will do once the waits settle." },
    },
    async execute(args, exec) {
      const stored = await deps.store.update(
        args.delegation,
        (record) => {
          if (pendingWaits(record).length === 0) throw new Error("nothing is pending; there is nothing to wait for");
          const parked = record.state === "open" ? transition(record, "waiting") : record;
          return exec.sessionId === undefined ? parked : { ...parked, supervisor: { ...parked.supervisor, session_id: exec.sessionId } };
        },
        () => ({ next: args.next }),
      );
      exec.concludeTurn?.();
      const targets = pendingWaits(stored.record).map((wait) => wait.target);
      return { text: `Waiting on ${targets.join(", ")}. This session will be woken with a brief when they settle.`, meta: stored };
    },
  };
}

/** How much of an answer the delegation record keeps. */
const ANSWER_CHARS = 2000;
/** How much of the answer an approval quotes as its note. */
const APPROVAL_NOTE_CHARS = 300;

interface ResumeArgs {
  delegation: string;
  answers: string;
  by?: string;
  evidence?: string[];
  approve?: { gate: Gate; target: string };
}

export function researchResume(deps: ResearchDeps): ToolSpec<ResumeArgs> {
  return {
    name: "research_resume",
    description: [
      "Continue a delegation that is blocked on a person (research_decide ask_human, or a plan waiting for approval) or paused, once they have answered.",
      "Their answer is recorded on the delegation (its answers log), so later steps and briefs carry it; with approve, their approval of a gate is recorded too. Then the delegation takes steps again.",
      "Pass approve only when their words clearly approve that target ('批准 <path>', 'approve <path>'); a refusal, a change request or silence is an answer without approve. Never fabricate an approval.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      answers: { type: "string", required: true, description: "What the person answered, as they gave it." },
      by: { type: "string", description: "Who answered. In a headless run (tack run) Tack overrides it with the caller identity (TACK_BY, else the OS user); a web client passes the signed-in person." },
      evidence: { type: "array", items: { type: "string" }, description: "Files or documents they supplied (e.g. the structure pptx once imported)." },
      approve: {
        type: "object",
        description: "The gate the person approved and its target (the plan path, the workflow or experiment path, the assessment Report path). Only when they clearly approved it.",
        additionalProperties: false,
        properties: {
          gate: { type: "string", required: true, enum: [...GATES] },
          target: { type: "string", required: true },
        },
      },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      if (current.record.state !== "blocked" && current.record.state !== "paused") throw new Error(`the delegation is ${current.record.state}; only a blocked or paused one resumes`);
      const by = exec.caller ?? args.by?.trim();
      if (by === undefined || by === "") throw new Error("say who answered (by)");
      if (args.approve !== undefined && args.approve.target.trim() === "") throw new Error("approve names the target the person approved");
      const answers = args.answers.trim();
      if (answers === "") throw new Error("record what the person answered (answers)");
      // The answer lives on the Delegation (its answers log), not in a document of its own.
      const answer = { path: current.path, by, text: clip(answers, ANSWER_CHARS) };
      const approval = args.approve === undefined ? undefined : { gate: args.approve.gate, target: args.approve.target.trim(), by, at: deps.now().toISOString(), note: clip(answers, APPROVAL_NOTE_CHARS) };
      const stored = await deps.store.update(
        current.path,
        (record) => {
          let resumed = recordAnswer(resume(record), answer);
          if (exec.wakeSupervisor === true) resumed = { ...resumed, supervisor: { ...resumed.supervisor, wake: "pending" } };
          return approval === undefined ? resumed : approve(resumed, approval);
        },
        () => ({ next: "act on the answer", evidence: [current.path, ...(args.evidence ?? [])] }),
        exec.expectedDigest,
      );
      const approved = approval === undefined ? "" : `; ${approval.gate} approved for ${approval.target} by ${by}`;
      return { text: `Recorded the answer on ${current.path}${approved}; the delegation is ${stored.record.state} again.`, meta: { answer, delegation: stored.path, ...(approval !== undefined && { approval }) } };
    },
  };
}
