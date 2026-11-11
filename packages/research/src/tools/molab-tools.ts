/**
 * Molab structure and compute, through the served scope. Molab decides run
 * identity, resume semantics and dispatch; these tools only call its verbs,
 * after the delegation's policy and budget allow it.
 *
 * Starting an attempt writes the wait (with its request key) into the
 * delegation *before* asking molab, so a lost response is found again by
 * reconcile and never blindly resubmitted.
 */
import { coveringApproval, type DelegationRecord, openWait, requireActive, requireApproved, requireBudget, resolveWait, spend } from "../delegation/model.js";
import { MolabError } from "../molab/client.js";
import { executionRef, experimentRef, projectRef, runRef } from "../molab/refs.js";
import { boundScope } from "./scope.js";
import { PLANNING_CLASSES, readCampaign, renderCampaign } from "../campaign.js";
import { requireAction, requireWithinScope } from "../policy.js";
import { clipJson, DELEGATION_PARAM, loadDelegation, type ResearchDeps, type ToolSpec } from "./types.js";
import { clip } from "../text.js";

const RUN_PARAMS = {
  project: { type: "string", required: true, description: "Project id (molab routes need it; use '-' when molab serves that project or below)." },
  experiment: { type: "string", required: true, description: "Experiment id." },
  run: { type: "string", required: true, description: "Run id." },
} as const;

export function researchContext(deps: ResearchDeps): ToolSpec<{ query?: string; projectId?: string; experimentId?: string; runId?: string; section?: string; offset?: number; limit?: number }> {
  return {
    name: "research_context",
    description: [
      "Read what already exists before adding work, whoever wrote it: the campaign (Plan, Roadmap stages, Todo items, Milestones), the served scope's experiments and runs, and other knowledge.",
      "Start broad, then narrow with projectId / experimentId / runId. Pass query to search knowledge (plans, findings, decisions, failure reports) by keyword.",
      "Check here before proposing an experiment that may already have run, or writing a script for a capability that may already exist.",
    ].join(" "),
    parameters: {
      query: { type: "string", description: "Keyword search over knowledge documents." },
      projectId: { type: "string" },
      experimentId: { type: "string" },
      runId: { type: "string" },
      section: { type: "string", description: "One structure array (e.g. experiments, recentRuns, assets), knowledge, or hits. Omit for a paged overview." },
      offset: { type: "integer", description: "Row offset (default 0)." },
      limit: { type: "integer", description: "Rows per section (default 10, maximum 100)." },
    },
    async execute(args, exec) {
      const served = await boundScope(deps.molab, exec.signal);
      const focus = { projectId: args.projectId, experimentId: args.experimentId, runId: args.runId };
      const [snapshot, docs, hits] = await Promise.all([
        deps.molab.context(focus, exec.signal),
        deps.molab.listDocs(exec.signal),
        args.query === undefined ? Promise.resolve(undefined) : deps.molab.search(args.query, undefined, exec.signal),
      ]);
      const campaign = await readCampaign(deps.molab, docs, exec.signal);
      const knowledge = docs
        .filter((doc) => !PLANNING_CLASSES.has(doc.cls))
        .map((doc) => ({ cls: doc.cls, path: doc.relPath, excerpt: doc.excerpt.slice(0, 160) }));
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.max(1, Math.min(100, args.limit ?? 10));
      const structure = withRefs(snapshot) as Row;
      const all: Row = { ...structure, knowledge, ...(hits !== undefined && { hits: hits.hits }) };
      if (args.section !== undefined && !(args.section in all)) throw new Error(`unknown section ${args.section}; choose ${Object.keys(all).join(", ")}`);
      const selected = args.section === undefined ? all : { [args.section]: all[args.section] };
      const page: Row = {};
      const pagination: Row = {};
      for (const [key, value] of Object.entries(selected)) {
        if (!Array.isArray(value)) { page[key] = value; continue; }
        page[key] = value.slice(offset, offset + limit);
        pagination[key] = { offset, limit, total: value.length, nextOffset: offset + limit < value.length ? offset + limit : null };
      }
      const sections = [
        `Served scope: ${served.kind} ${served.name}${served.ref !== undefined ? ` (${served.ref})` : ""}`,
        ...(args.section === undefined ? [`Campaign:\n${clip(renderCampaign(campaign), 3000)}`] : []),
        `Structure (each entry carries the ref the research tools take):\n${clipJson(page, 7_000)}`,
        `Pagination (select section, then offset/limit):\n${JSON.stringify(pagination)}`,
      ];
      return { text: sections.join("\n\n"), meta: { page, pagination } };
    },
  };
}

type Row = Record<string, unknown>;
const rowsOf = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null) : [];

/**
 * The context snapshot with a `ref` on every project, experiment and run, in
 * the `molab:` form the research tools take (ids alone are refused there).
 */
export function withRefs(snapshot: unknown): unknown {
  if (typeof snapshot !== "object" || snapshot === null) return snapshot;
  const view = snapshot as Row;
  const annotate = (key: string, ref: (row: Row) => string | undefined) =>
    key in view ? { [key]: rowsOf(view[key]).map((row) => ({ ref: ref(row), ...row })) } : {};
  const run = (row: Row) =>
    typeof row.experimentId === "string" && typeof row.runId === "string" ? runRef(row.experimentId, row.runId) : undefined;
  return {
    ...view,
    ...annotate("projects", (row) => (typeof row.id === "string" ? projectRef(row.id) : undefined)),
    ...annotate("experiments", (row) => (typeof row.id === "string" ? experimentRef(row.id) : undefined)),
    ...annotate("recentRuns", run),
    ...annotate("failedRuns", run),
    ...annotate("runningRuns", run),
  };
}

interface CreateExperimentArgs {
  delegation: string;
  project: string;
  name: string;
  description?: string;
  parameterSpace?: Record<string, unknown>;
  workflowSource?: Record<string, unknown>;
  defaultTarget?: string;
}

export function molabCreateExperiment(deps: ResearchDeps): ToolSpec<CreateExperimentArgs> {
  return {
    name: "molab_create_experiment",
    description:
      "Create an experiment: a new testable question or comparison design. Changing the hypothesis, main method or comparison design is a new experiment; varying declared parameters or seeds is a new run in the existing one.",
    parameters: {
      ...DELEGATION_PARAM,
      project: { type: "string", required: true, description: "Project id." },
      name: { type: "string", required: true },
      description: { type: "string" },
      parameterSpace: { type: "json", description: "Parameter space definition." },
      workflowSource: { type: "json", description: "Workflow IR document, bound as the document kind." },
      defaultTarget: { type: "string", description: "Compute target new runs default to." },
    },
    async execute(args, exec) {
      const { record } = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(record);
      requireAction(record, "molab_create_experiment");
      const { delegation: _delegation, project, ...body } = args;
      const experiment = await deps.molab.createExperiment(project, body);
      return { text: `Created experiment ${experiment.name} (${experiment.id}), ref ${experiment.ref}.`, meta: experiment };
    },
  };
}

export function molabCreateRun(deps: ResearchDeps): ToolSpec<{ delegation: string; project: string; experiment: string; params: Record<string, unknown>; target?: string }> {
  return {
    name: "molab_create_run",
    description:
      "Create a run in an experiment: one set of declared parameters (including the seed). A retry of a failed attempt is not a new run; start a new attempt with molab_start_execution instead.",
    parameters: {
      ...DELEGATION_PARAM,
      project: { type: "string", required: true },
      experiment: { type: "string", required: true },
      params: { type: "json", required: true, description: "Run parameters." },
      target: { type: "string", description: "Compute target hint." },
    },
    async execute(args, exec) {
      const { record } = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(record);
      requireAction(record, "molab_create_run");
      requireWithinScope(record.scope, experimentRef(args.experiment), args.project === "-" ? undefined : args.project);
      const run = await deps.molab.createRun(args.project, args.experiment, { params: args.params, ...(args.target !== undefined && { target: args.target }) });
      return { text: `Created run ${run.name} (${run.id}), ref ${runRef(args.experiment, run.id)}.`, meta: run };
    },
  };
}

/** The experiment's workspace path, which a dry_run approval names (or lies under); its ref when molab does not list it. */
async function experimentPath(deps: ResearchDeps, project: string, experiment: string, signal?: AbortSignal): Promise<string> {
  const found = (await deps.molab.listExperiments(project, signal)).find((item) => item.id === experiment);
  return found?.path ?? experimentRef(experiment);
}

/** Gate dry_run: nothing executes in an experiment before a person approved its workflow's dry run. */
async function requireDryRunApproved(deps: ResearchDeps, record: DelegationRecord, project: string, experiment: string, signal?: AbortSignal): Promise<void> {
  if (!deps.config.gates.dryRun) return;
  const path = await experimentPath(deps, project, experiment, signal);
  if (coveringApproval(record, "dry_run", path) === undefined) requireApproved(record, "dry_run", path);
}

export function molabDryRun(deps: ResearchDeps): ToolSpec<{ delegation?: string; experiment: string; project?: string; source?: "code" | "stored" }> {
  return {
    name: "molab_dry_run",
    description: [
      "Preview without creating records. Default source code imports the current script in an isolated scratch process and shows its declared runs. source stored walks saved IR and registered run inventory, which may include historical/adopted runs and is not a source execution plan.",
      "404 when no workflow is stored yet (a draft worker round writes it); 400 when it does not compile. Quote the waves when asking the person to approve the dry run (research_decide ask_human, gate dry_run).",
    ].join(" "),
    parameters: {
      delegation: { type: "string", description: "Optional Delegation path. Without it, inspect read-only within the served Molab scope." },
      experiment: { type: "string", required: true, description: "Experiment id." },
      project: { type: "string", description: "Project id ('-' when molab serves that project or below; the default)." },
      source: { type: "string", enum: ["code", "stored"], description: "code (default): current source declaration; stored: saved graph and registered inventory." },
    },
    async execute(args, exec) {
      const project = args.project ?? "-";
      if (args.delegation !== undefined) {
        const { record } = await loadDelegation(deps, args.delegation, exec.signal);
        requireAction(record, "molab_dry_run");
        requireWithinScope(record.scope, experimentRef(args.experiment), project === "-" ? undefined : project);
      }
      let dry;
      try {
        dry = await deps.molab.dryRun(project, args.experiment, exec.signal, args.source ?? "code");
      } catch (error) {
        if (error instanceof MolabError && error.status === 404) {
          throw new Error(`no workflow is stored for experiment ${args.experiment} yet: dispatch a draft round (research_dispatch mode draft) so the worker writes and dry-runs it`, { cause: error });
        }
        if (error instanceof MolabError && error.status === 400) throw new Error(`the workflow of experiment ${args.experiment} does not compile: ${error.detail}. Send it back to the worker.`, { cause: error });
        throw error;
      }
      const path = dry.experiment.path;
      const waves = dry.waves.map((wave, index) => `- wave ${index + 1}: ${wave.join(", ")}`);
      const branches = dry.branches.map((branch) => `- ${branch.source} → ${branch.target}${branch.label ? ` (${branch.label})` : ""}`);
      const text = [
        `Dry run of workflow ${dry.workflow.name} for experiment ${dry.experiment.name} (${dry.experiment.id}, ${path}): ${dry.waves.length} wave(s), ${dry.runs.length} run(s), ${dry.branches.length} branch(es). Nothing was executed.`,
        `Source: ${dry.source}${dry.entrypoint ? ` (${dry.entrypoint})` : ""}. ${dry.source === "stored" ? "Saved graph and registered run inventory; not a preview of the current source sweep." : "Current source declaration; use source stored to inspect historical/adopted run inventory."}`,
        ["Waves:", ...(waves.length > 0 ? waves : ["- (none)"])].join("\n"),
        ...(branches.length > 0 ? [["Branches:", ...branches].join("\n")] : []),
        `Runs:\n${clipJson(
          dry.runs.map((run) => run.params),
          3_000,
        )}`,
        ...(deps.config.gates.dryRun ? [`Before execution under a delegation, a person approves the source dry run: research_decide(decision: "ask_human", gate: {gate: "dry_run", target: "${path}"}). Use source code, not historical inventory, for this gate. research_resume records their approval. This inspection records no approval.`] : []),
      ].join("\n\n");
      return { text, meta: dry };
    },
  };
}

interface StartArgs {
  delegation: string;
  project: string;
  experiment: string;
  run: string;
  mode?: "initial" | "rerun" | "resume" | "reproduce";
  basedOnExecutionId?: string;
  target?: string;
  onResolve: string;
  deadlineHours?: number;
}

export function molabStartExecution(deps: ResearchDeps): ToolSpec<StartArgs> {
  return {
    name: "molab_start_execution",
    description: [
      "Start one attempt of a run through molab and record a wait for it in the delegation. molab submits every attempt it creates: to this machine by default (target local), or to a registered compute target via molq.",
      "mode: initial for a new run; resume continues a failed attempt from its completed nodes; rerun recomputes; reproduce checks a succeeded one.",
      "Gate dry_run: refused until a person approved the dry run of the experiment's workflow (molab_dry_run, then research_decide ask_human). Then call research_wait instead of polling.",
    ].join(" "),
    parameters: {
      ...DELEGATION_PARAM,
      ...RUN_PARAMS,
      mode: { type: "string", enum: ["initial", "rerun", "resume", "reproduce"] },
      basedOnExecutionId: { type: "string", description: "Predecessor attempt for resume / rerun / reproduce." },
      target: { type: "string", description: "Compute target name (default: local, this machine)." },
      onResolve: { type: "string", required: true, description: "What you will do with the result." },
      deadlineHours: { type: "number", description: "Give up waiting after this many hours." },
    },
    async execute(args, exec) {
      const { path, record } = await loadDelegation(deps, args.delegation, exec.signal);
      requireActive(record);
      requireAction(record, "molab_start_execution");
      requireWithinScope(record.scope, runRef(args.experiment, args.run), args.project === "-" ? undefined : args.project);
      requireBudget(record, { executions: 1 });
      await requireDryRunApproved(deps, record, args.project, args.experiment, exec.signal);
      const waitId = `w${deps.newId()}`;
      const requestKey = `tack:${waitId}`;
      const deadline = args.deadlineHours === undefined ? undefined : new Date(deps.now().getTime() + args.deadlineHours * 3_600_000).toISOString();
      // 1. Intent first: the wait and its key are durable before molab is asked.
      await deps.store.update(path, (current) =>
        spend(
          openWait(current, {
            id: waitId,
            target: runRef(args.experiment, args.run),
            project: args.project,
            request_key: requestKey,
            on_resolve: args.onResolve,
            ...(deadline !== undefined && { deadline }),
          }),
          { executions: 1 },
        ),
      );
      // 2. Ask molab. Retrying with the same key returns the same attempt.
      const at = { project: args.project, experiment: args.experiment, run: args.run };
      let execution;
      try {
        execution = await deps.molab.createExecution(at, {
          ...(args.mode !== undefined && { mode: args.mode }),
          ...(args.basedOnExecutionId !== undefined && { basedOnExecutionId: args.basedOnExecutionId }),
          ...(args.target !== undefined && { target: args.target }),
          requestKey,
          requestedBy: deps.config.createdBy,
        });
      } catch (error) {
        if (error instanceof MolabError && error.status >= 400 && error.status < 500) {
          await deps.store.update(path, (current) => resolveWait(current, waitId, `refused: ${error.detail}`, "expired"));
        }
        throw error;
      }
      // 3. Pin the wait to the attempt molab created.
      const target = executionRef(args.experiment, args.run, execution.id);
      const stored = await deps.store.update(path, (current) => ({
        ...current,
        waits: current.waits.map((wait) => (wait.id === waitId ? { ...wait, target } : wait)),
      }));
      return {
        text: `Started attempt ${execution.id} (${execution.status}) of run ${args.run}; wait ${waitId} records it. Call research_wait to park until it settles.`,
        meta: { execution, delegation: stored },
      };
    },
  };
}

export function molabCancelExecution(deps: ResearchDeps): ToolSpec<{ delegation: string; project: string; experiment: string; run: string; execution: string }> {
  return {
    name: "molab_cancel_execution",
    description: "Cancel molab compute: one attempt of a run (its molq job too). Pausing the delegation does not do this.",
    parameters: { ...DELEGATION_PARAM, ...RUN_PARAMS, execution: { type: "string", required: true, description: "Attempt id, e.g. e01." } },
    async execute(args, exec) {
      const { record } = await loadDelegation(deps, args.delegation, exec.signal);
      requireAction(record, "molab_cancel_execution");
      requireWithinScope(record.scope, executionRef(args.experiment, args.run, args.execution), args.project === "-" ? undefined : args.project);
      const result = await deps.molab.cancelExecution({ project: args.project, experiment: args.experiment, run: args.run }, args.execution);
      return { text: `Cancel requested for ${executionRef(args.experiment, args.run, args.execution)}.`, meta: result };
    },
  };
}

export function molabReadOutputs(deps: ResearchDeps): ToolSpec<{ project: string; experiment: string; run: string; execution: string; log?: "stdout" | "stderr" | "run"; offset?: number; limit?: number; section?: "summary" | "results" | "assets" | "evidence" | "unregistered" }> {
  return {
    name: "molab_read_outputs",
    description:
      "Read one attempt's evidence: without log, its outputs (status, results, artifacts, evidence files); with log, one window of stdout / stderr / run.log from offset (pass nextOffset back to continue).",
    parameters: {
      ...RUN_PARAMS,
      execution: { type: "string", required: true },
      log: { type: "string", enum: ["stdout", "stderr", "run"] },
      offset: { type: "integer", description: "Byte offset for logs, row offset for output sections (default 0)." },
      limit: { type: "integer", description: "Output rows per section (default 20)." },
      section: { type: "string", enum: ["summary", "results", "assets", "evidence", "unregistered"], description: "Default summary: results and paged assets/evidence; logs are read separately." },
    },
    async execute(args, exec) {
      const at = { project: args.project, experiment: args.experiment, run: args.run };
      if (args.log === undefined) {
        const outputs = await deps.molab.outputs(at, args.execution, exec.signal) as Row;
        const offset = Math.max(0, args.offset ?? 0);
        const limit = Math.max(1, Math.min(100, args.limit ?? 20));
        const section = args.section ?? "summary";
        const selected: Row = section === "summary" ? {
          executionId: outputs.executionId, results: outputs.results,
          assets: outputs.assets, evidence: outputs.evidence,
          unregisteredCount: rowsOf(outputs.unregistered).length,
          stdoutAvailable: Boolean(outputs.stdout), stderrAvailable: Boolean(outputs.stderr),
        } : { [section]: outputs[section] };
        const pagination: Row = {};
        for (const [key, value] of Object.entries(selected)) {
          if (!Array.isArray(value)) continue;
          selected[key] = value.slice(offset, offset + limit);
          pagination[key] = { offset, limit, total: value.length, nextOffset: offset + limit < value.length ? offset + limit : null };
        }
        const value = { ...selected, pagination };
        return { text: clipJson(value), meta: value };
      }
      const chunk = await deps.molab.log(at, args.execution, args.log, args.offset ?? 0, exec.signal);
      return { text: `${chunk.text}\n[nextOffset ${chunk.nextOffset}${chunk.eof ? ", end of file" : ""}]` };
    },
  };
}
