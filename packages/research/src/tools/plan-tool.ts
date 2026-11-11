/**
 * `research_plan`: the delegation's testable plan as a molab Plan, with the
 * simulation parameters it fixes and where each came from. Two human gates
 * meet here: an uncertain parameter is asked, never guessed (gate
 * parameters), and the written plan blocks the delegation until a person
 * approves it (gate plan), so no worker is dispatched on a plan nobody read.
 *
 * A delegation has one plan document under a stable name. A revision rewrites
 * it in place (molab's history keeps each version) and withdraws its
 * approval; nothing is kept beside it as "v2".
 */
import { z } from "zod";
import { block, forgetWrites, isApproved, requireActive, revoke } from "../delegation/model.js";
import { requireAction } from "../policy.js";
import { MolabError } from "../molab/client.js";
import { PlanWorkflow, type PlanWorkflowJSON } from "../plan-workflow.js";
import type { StoredDelegation } from "../delegation/store.js";
import { contentKey, deleteDoc, hostOf, writeCited } from "./records.js";
import { DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec } from "./types.js";

export const PARAMETER_SOURCES = ["human", "default", "literature", "derived"] as const;

const PlanParameter = z
  .object({
    name: z.string().min(1),
    value: z.string().min(1),
    source: z.enum(PARAMETER_SOURCES),
    uncertain: z.boolean().default(false),
    note: z.string().optional(),
  })
  .strict();
export type PlanParameter = z.infer<typeof PlanParameter>;
const PlanParameters = z.array(PlanParameter);

/** What every simulation plan states, each a line of its Parameters table. */
export const PARAMETER_CHECKLIST: readonly string[] = [
  "system size and composition",
  "force field and parameter set",
  "charge model",
  "box, periodic boundaries and density",
  "ensemble, thermostat and barostat",
  "timestep and duration",
  "seeds",
  "acceptance tolerances",
];

interface PlanArgs {
  delegation: string;
  name: string;
  hypothesis: string;
  comparison: string;
  fixed: string[];
  varied: string[];
  runs: string;
  judgement: string;
  products: string[];
  parameters: PlanParameter[];
  no_parameters_reason?: string;
  reason?: string;
  workflow?: PlanWorkflowJSON;
}

const list = (items: readonly string[]): string => (items.length === 0 ? "- (none)" : items.map((item) => `- ${item}`).join("\n"));
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function parametersTable(parameters: readonly PlanParameter[], reason: string | undefined): string[] {
  if (parameters.length === 0) return [`No parameters are fixed by this plan: ${reason ?? "(no reason given)"}`];
  return [
    "| parameter | value | source | confirmed | note |",
    "| --- | --- | --- | --- | --- |",
    ...parameters.map((item) => `| ${cell(item.name)} | ${cell(item.value)} | ${item.source} | ${item.uncertain ? "no" : "yes"} | ${cell(item.note ?? "")} |`),
  ];
}

function parsedParameters(raw: unknown): PlanParameter[] {
  const parsed = PlanParameters.safeParse(raw ?? []);
  if (!parsed.success) throw new Error(`invalid parameters: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function researchPlan(deps: ResearchDeps): ToolSpec<PlanArgs> {
  return {
    name: "research_plan",
    description: [
      "Write the delegation's testable plan as a molab Plan: hypothesis, comparison, fixed and varied variables, what each run is, how results are judged, the expected products, and the parameters table.",
      `parameters: every simulation parameter the plan fixes (checklist: ${PARAMETER_CHECKLIST.join("; ")}), each with its value and source. Mark one uncertain when nobody confirmed it: an uncertain parameter is asked first (research_decide ask_human), never guessed, and the plan is refused until a person answered.`,
      "The written plan blocks the delegation until a person approves it (gate plan): end your turn; their answer arrives in the next round and research_resume records it.",
      "A delegation has one plan document. To change it, call research_plan again with the same name and a reason: the plan is rewritten in place (molab's history keeps every earlier version), its approval is withdrawn, and the revision needs a person's approval again. A plan written under another name replaces the old document, which is deleted.",
      "Include workflow to visualize this experiment in its conversation's workbench: stable node IDs, typed nodes and explicit dependency edges, with nested blocks/edges for bounded loops. This graph belongs to the Plan; it is not an execution engine. Include it on each revision; omitting it produces a text-only Plan.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      name: { type: "string", required: true, description: "Plan title. Stable: no version, date or round in it; a revision keeps the name." },
      hypothesis: { type: "string", required: true },
      comparison: { type: "string", required: true, description: "Against what, and what makes the comparison fair." },
      fixed: { type: "array", required: true, items: { type: "string" }, description: "Variables held fixed." },
      varied: { type: "array", required: true, items: { type: "string" }, description: "Variables that change." },
      runs: { type: "string", required: true, description: "What each run is (conditions, seeds, replicates)." },
      judgement: { type: "string", required: true, description: "Metric, tolerance, and what result supports or refutes the hypothesis." },
      products: { type: "array", required: true, items: { type: "string" }, description: "Expected products (data, figures, numbers)." },
      parameters: {
        type: "array",
        required: true,
        description: "The simulation parameters the plan fixes; empty only with no_parameters_reason.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true },
            value: { type: "string", required: true, description: "As written, with units." },
            source: { type: "string", required: true, enum: [...PARAMETER_SOURCES], description: "human: a person gave it; default: a tool's default; literature: cited; derived: computed from others." },
            uncertain: { type: "boolean", description: "True when nobody confirmed it; the plan is refused until a person answers." },
            note: { type: "string", description: "The citation, the person, or the derivation." },
          },
        },
      },
      no_parameters_reason: { type: "string", description: "Why the plan fixes no parameter (only with an empty parameters list)." },
      reason: { type: "string", description: "Why the plan changes (required once the delegation has a plan)." },
      workflow: { type: "object", additionalProperties: false, description: "The Plan's workbench graph. Nodes use stable id, type (input, agent, tool, parallel, condition, review, output, loop, continue, exit), data.title and optional meta.position. Loop nodes own blocks and edges. Edges use sourceNodeID, targetNodeID and optional sourcePortID/targetPortID. Do not invent execution statuses.", properties: {
        nodes: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
        edges: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
      } },
    },
    async execute(args, exec) {
      const current = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(current.record);
      requireAction(current.record, "research_plan");
      const gates = deps.config.gates;
      const parameters = parsedParameters(args.parameters);
      const workflow = args.workflow === undefined ? undefined : PlanWorkflow.parse(args.workflow);
      if (parameters.length === 0 && (args.no_parameters_reason ?? "").trim() === "") {
        throw new Error("list the parameters the plan fixes (parameters), or say why there are none (no_parameters_reason)");
      }
      const uncertain = parameters.filter((item) => item.uncertain);
      if (uncertain.length > 0 && gates.parameters) {
        throw new Error(
          `uncertain parameter${uncertain.length === 1 ? "" : "s"} ${uncertain.map((item) => item.name).join(", ")}: ask the person first (research_decide ask_human with the parameter questions, one per uncertain parameter, gate parameters), then plan with their answers. Do not guess.`,
        );
      }
      const previous = current.record.current_plan ?? undefined;
      const content = contentKey(args.name, args.hypothesis, args.comparison, parameters, args.no_parameters_reason ?? "", args.fixed, args.varied, args.runs, args.judgement, args.products, ...(workflow === undefined ? [] : [workflow]));
      if (previous !== undefined) {
        const prior = await priorPlanKey(deps, previous, exec.signal);
        // The same plan again (a retry): nothing to write, nothing to withdraw.
        if (prior === content) return planResult(previous, await deps.store.get(current.path, exec.signal), "");
        if ((args.reason ?? "").trim() === "") throw new Error(`the delegation already has a plan (${previous}): say why it changes (reason); the revision replaces it and needs approval again`);
      }
      const body = [
        `# ${args.name}`,
        "",
        `Delegation: ${current.path}`,
        ...(previous !== undefined ? ["", "## Why this revision", "", args.reason!.trim()] : []),
        "",
        "## Hypothesis",
        "",
        args.hypothesis,
        "",
        "## Comparison",
        "",
        args.comparison,
        "",
        "## Parameters",
        "",
        ...parametersTable(parameters, args.no_parameters_reason),
        "",
        "## Fixed",
        "",
        list(args.fixed),
        "",
        "## Varied",
        "",
        list(args.varied),
        "",
        "## Runs",
        "",
        args.runs,
        "",
        "## Judgement",
        "",
        args.judgement,
        "",
        "## Expected products",
        "",
        list(args.products),
        "",
      ].join("\n");
      // One plan per delegation, revised in place under its name: no second document, no version in a file name.
      const plan = await writeCited(
        deps,
        {
          name: args.name,
          cls: "Plan",
          hostPath: hostOf(current.path),
          body,
          record: {
            delegation: current.path,
            parameters,
            workflow: workflow ?? null,
            ...(parameters.length === 0 && { no_parameters_reason: args.no_parameters_reason!.trim() }),
            content_key: content,
            ...(previous !== undefined && { revision_reason: args.reason!.trim() }),
          },
        },
        [current.record.scope, current.path],
        current.record.scope,
        "cites",
      );
      const replaced = previous !== undefined && previous !== plan.relPath ? previous : undefined;
      if (replaced !== undefined) await deleteDoc(deps, replaced);
      // Gate plan: the plan waits for a person; a retried call on an approved plan does not block again.
      const question = `Approve this plan? Answer 'approve ${plan.relPath}', or list the changes it needs.`;
      const stored = await deps.store.update(
        current.path,
        (record) => {
          // A revision withdraws the approval of what it replaces: the person approves what the plan now says.
          const revised = previous === undefined ? record : forgetWrites(revoke(revoke(record, "plan", previous), "plan", plan.relPath), previous);
          const planned = { ...revised, current_plan: plan.relPath };
          return gates.plan && !isApproved(planned, "plan", plan.relPath) ? block(planned, [question], { gate: "plan", target: plan.relPath }) : planned;
        },
        (record) => ({ next: record.state === "blocked" ? "a person approves the plan (research_resume approve); then research_dispatch" : "dispatch the first worker round (research_dispatch)" }),
      );
      return planResult(plan.relPath, stored, replaced !== undefined ? ` (replaces ${replaced}, now deleted)` : previous !== undefined ? " (revised in place; its approval is withdrawn)" : "");
    },
  };
}

/** The content key the plan at `path` was written with; undefined when it is gone or predates the key. */
async function priorPlanKey(deps: ResearchDeps, path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const key = (await deps.molab.getRecord(path, signal)).record.content_key;
    return typeof key === "string" ? key : undefined;
  } catch (error) {
    if (error instanceof MolabError && error.status === 404) return undefined;
    throw error;
  }
}

function planResult(path: string, stored: StoredDelegation, change: string): { text: string; meta: unknown } {
  if (stored.record.state === "blocked") {
    return {
      text: `Wrote plan ${path}${change}; it is the delegation's current plan and waits for a person's approval (gate plan). End your turn: their answer arrives as the next prompt; record it with research_resume (approve: {gate: "plan", target: "${path}"} only if they approved it), then research_dispatch.`,
      meta: { plan: { relPath: path }, delegation: stored },
    };
  }
  return { text: `Wrote plan ${path}${change}; it is now the delegation's current plan. Next: research_dispatch.`, meta: { plan: { relPath: path }, delegation: stored } };
}
