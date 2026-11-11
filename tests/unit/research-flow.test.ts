/**
 * The research loop against an in-memory molab: open → plan → start an
 * attempt → wait → the watcher settles it and wakes the supervisor → assess →
 * decide. Plus the failure paths that matter for long-running research: a
 * lost submit response, a concurrent record write, a refused worker result,
 * and an exhausted budget.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { parseConfig } from "../../packages/research/src/config.js";
import { approve, type Gate } from "../../packages/research/src/delegation/model.js";
import { DelegationStore } from "../../packages/research/src/delegation/store.js";
import { losslessValue } from "../../packages/research/src/dsh/adapter.js";
import { researchTools } from "../../packages/research/src/index.js";
import { MolabClient } from "../../packages/research/src/molab/client.js";
import { reconcile } from "../../packages/research/src/reconcile.js";
import type { ResearchDeps, ToolExec, ToolSpec } from "../../packages/research/src/tools/types.js";
import { Watcher } from "../../packages/research/src/watcher.js";
import { WorkerLedger } from "../../packages/research/src/workers.js";
import { type FakeMolab, startFakeMolab } from "../fake-molab.js";
import { fakeWorkers } from "../fake-workers.js";

interface Harness {
  molab: FakeMolab;
  deps: ResearchDeps;
  tool(name: string): ToolSpec<Record<string, unknown>>;
  wakes: { sessionId: string | undefined; text: string }[];
  watcher: Watcher;
}

let h: Harness;
const exec = (over: Partial<ToolExec> = {}): ToolExec => ({ signal: new AbortController().signal, sessionId: "S1", ...over });

async function harness(): Promise<Harness> {
  const molab = await startFakeMolab();
  const client = new MolabClient({ url: molab.url });
  const store = new DelegationStore(client, "tack");
  const wakes: Harness["wakes"] = [];
  let id = 0;
  const now = () => new Date("2026-11-03T12:00:00Z");
  const logger = { warn: () => {} };
  const deps: ResearchDeps = {
    config: parseConfig({}),
    molab: client,
    store,
    workers: fakeWorkers().port,
    ledger: new WorkerLedger(store, now, logger),
    logger,
    validate: async () => molab.violations,
    now,
    newId: () => String(++id),
  };
  const tools = new Map(researchTools(deps).map((spec) => [spec.name, spec as ToolSpec<Record<string, unknown>>]));
  const watcher = new Watcher(client, store, {
    wake: async (sessionId, text) => {
      wakes.push({ sessionId, text });
      return sessionId ?? "S-new";
    },
  }, { info: () => {}, warn: () => {} });
  return {
    molab,
    deps,
    tool: (name) => {
      const spec = tools.get(name);
      if (spec === undefined) throw new Error(`no tool ${name}`);
      // Every value must reach DSH intact once the adapter normalizes it.
      return {
        ...spec,
        execute: async (args, exec) => {
          const value = await spec.execute(args, exec);
          expect(JSON.parse(JSON.stringify(losslessValue(value)))).toEqual(losslessValue(value));
          return value;
        },
      };
    },
    wakes,
    watcher,
  };
}

async function openDelegation(actions = ["read", "create_run", "start_execution", "write_knowledge", "delegate_worker"], budget: Record<string, number> = { executions: 3, worker_runs: 2 }) {
  const opened = await h.tool("research_open").execute(
    { name: "Sequence study", goal: "Does sequence order change conductivity?", actions, budget, acceptance: ["3 seeds per sequence"], stop_conditions: ["budget exhausted"] },
    exec(),
  );
  return (opened.meta as { path: string }).path;
}

/** A person's approval written straight onto the record, as a web client would. */
async function approved(path: string, gate: Gate, target: string): Promise<void> {
  await h.deps.store.update(path, (record) => approve(record, { gate, target, by: "roykid", at: "2026-11-03T12:00:00.000Z" }));
}

describe("research loop over molab", () => {
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.molab.close();
  });

  it("opens a delegation as a Delegation document bound to the served scope", async () => {
    const path = await openDelegation();
    expect(path).toBe("knowledges/sequence-study.md");
    const doc = h.molab.docs.get(path)!;
    expect(doc.cls).toBe("Delegation");
    expect(doc.createdBy).toBe("tack");
    expect(doc.sources).toEqual([{ kind: "project", ref: "molab:project/P1" }]);
    expect(doc.record).toMatchObject({ scope: "molab:project/P1", state: "open", supervisor: { session_id: "S1" } });
    expect(doc.body).toContain("## Status");
  });

  it("runs plan → approval → dry-run approval → attempt → wait → wake → assess → results approval → conclude, all as knowledge", async () => {
    const path = await openDelegation();
    const { experiment, run } = h.molab.seedRun();

    const plan = await h.tool("research_plan").execute(
      {
        delegation: path,
        name: "Screen",
        hypothesis: "Blocky sequences conduct better",
        comparison: "ABAB vs AABB at fixed composition",
        fixed: ["T=400K"],
        varied: ["sequence"],
        runs: "3 seeds each",
        judgement: "sigma ratio > 1.2 with non-overlapping 95% CI",
        products: ["sigma per run"],
        parameters: [{ name: "temperature", value: "400 K", source: "human", note: "the goal" }],
      },
      exec(),
    );
    const planPath = (plan.meta as { plan: { relPath: string } }).plan.relPath;
    expect(h.molab.docs.get(planPath)!.cls).toBe("Plan");
    expect(h.molab.docs.get(planPath)!.edges).toEqual([{ target: path, role: "cites" }]);
    expect(h.molab.docs.get(planPath)!.body).toContain("| temperature | 400 K | human | yes | the goal |");
    // Gate plan: the plan blocks the delegation; the person's approval (a web client names the person) resumes it.
    expect((h.molab.docs.get(path)!.record as { state: string }).state).toBe("blocked");
    await expect(h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, onResolve: "x" }, exec())).rejects.toThrow(/blocked on a person: \[gate:plan/);
    await h.tool("research_resume").execute({ delegation: path, answers: `批准 ${planPath}`, by: "roykid", approve: { gate: "plan", target: planPath } }, exec());

    // Gate dry_run: the supervisor asks with the gate; the answer approves the experiment's path.
    await expect(h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, onResolve: "x" }, exec())).rejects.toThrow(/dry_run gate is pending for experiments\/screen-1/);
    const asked = await h.tool("research_decide").execute(
      { delegation: path, name: "Run wave 1?", decision: "ask_human", reason: "dry run compiled", evidence: [path], gate: { gate: "dry_run", target: "experiments/screen-1" }, questions: ["Execute seq=ABAB seed=1?"] },
      exec(),
    );
    expect((asked.meta as { decision: { questions: string[] } }).decision.questions).toEqual(["[gate:dry_run target:experiments/screen-1] Execute seq=ABAB seed=1?"]);
    // A decision is an entry of the delegation's log, not a document of its own.
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Observation")).toEqual([]);
    await h.tool("research_resume").execute({ delegation: path, answers: "approve experiments/screen-1", by: "roykid", approve: { gate: "dry_run", target: "experiments/screen-1" } }, exec());

    await h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, target: "local", onResolve: "assess sigma" }, exec());
    expect(h.molab.executions.get(run)).toHaveLength(1);
    let record = h.molab.docs.get(path)!.record as { waits: { target: string; request_key: string }[]; spent: { executions: number }; current_plan: string };
    expect(record.waits[0]!.target).toBe(`molab:experiment/${experiment}/run/${run}/execution/e01`);
    expect(record.spent.executions).toBe(1);
    expect(record.current_plan).toBe(planPath);

    let concluded = false;
    const waited = await h.tool("research_wait").execute({ delegation: path, next: "assess" }, exec({ concludeTurn: () => (concluded = true) }));
    expect(concluded).toBe(true);
    expect(waited.text).toContain("e01");

    await h.watcher.tick();
    expect(h.wakes).toHaveLength(0);

    h.molab.settle(run, "e01", "succeeded");
    await h.watcher.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.sessionId).toBe("S1");
    expect(h.wakes[0]!.text).toContain("succeeded");
    record = h.molab.docs.get(path)!.record as typeof record & { state: string; supervisor: Record<string, string> };
    expect((record as unknown as { state: string }).state).toBe("open");
    expect((record as unknown as { supervisor: Record<string, string> }).supervisor.wake).toBeUndefined();

    await h.watcher.tick();
    expect(h.wakes).toHaveLength(1);

    const assessed = await h.tool("research_assess").execute(
      {
        delegation: path,
        target: `molab:experiment/${experiment}/run/${run}/execution/e01`,
        project: "P1",
        name: "Screen v1 seed 1",
        execution: { verdict: "pass", reason: "exit 0" },
        data: { verdict: "pass", reason: "all frames present" },
        analysis: { verdict: "pass", reason: "diffusive regime 10-100 ns" },
        conclusion: { verdict: "unknown", reason: "one seed only" },
        evidence: [`molab:experiment/${experiment}/run/${run}/execution/e01`],
      },
      exec(),
    );
    const reportPath = (assessed.meta as { report: { relPath: string } }).report.relPath;
    const report = h.molab.docs.get(reportPath)!;
    expect(report.cls).toBe("Report");
    expect(report.hostPath).toContain("/runs/");
    expect(report.sources).toEqual([{ kind: "run", ref: `molab:experiment/${experiment}/run/${run}` }]);
    expect(report.record).toMatchObject({ assessment: { data: { verdict: "pass" } } });

    // Gate results: the conclusion waits for the person's approval of the latest assessment.
    const conclude = {
      delegation: path,
      name: "Blocky wins under CG",
      decision: "conclude",
      reason: "sigma ratio 1.4, CI separated",
      evidence: [reportPath, `molab:experiment/${experiment}/run/${run}`],
      finding: { name: "Blocky sequences conduct better", statement: "AABB conducts 1.4x ABAB", scope: "CG model v2, 400 K", host: "experiments/screen-1" },
    };
    await expect(h.tool("research_decide").execute(conclude, exec())).rejects.toThrow(new RegExp(`results gate is pending for ${reportPath}`));
    await h.tool("research_decide").execute({ delegation: path, name: "Accept seed 1?", decision: "ask_human", reason: "assessed", evidence: [reportPath], gate: { gate: "results", target: reportPath }, questions: ["All four levels pass; accept?"] }, exec());
    await h.tool("research_resume").execute({ delegation: path, answers: `批准 ${reportPath}`, by: "roykid", approve: { gate: "results", target: reportPath } }, exec());

    const decided = await h.tool("research_decide").execute(conclude, exec());
    const meta = decided.meta as { finding: { relPath: string } };
    expect(h.molab.docs.get(meta.finding.relPath)!.cls).toBe("Finding");
    expect(h.molab.docs.get(meta.finding.relPath)!.body).toContain(`Concluded in ${path}.`);
    // The knowledge graph links the conclusion back to its question: the finding refers to the assessment that judged it and to the plan it answers, the assessment to the plan.
    const refersTo = (doc: string) => h.molab.docs.get(doc)!.edges.filter((edge) => edge.role === "derived_from").map((edge) => edge.target);
    expect(refersTo(meta.finding.relPath)).toEqual(expect.arrayContaining([reportPath, planPath]));
    expect(refersTo(reportPath)).toContain(planPath);
    const closed = h.molab.docs.get(path)!.record as { state: string; approvals: { gate: string; target: string; by: string }[]; decisions: { kind: string; evidence: string[] }[] };
    expect(closed.decisions.map((decision) => decision.kind)).toEqual(["ask_human", "ask_human", "conclude"]);
    expect(closed.decisions.at(-1)!.evidence).toEqual([reportPath, `molab:experiment/${experiment}/run/${run}`, meta.finding.relPath]);
    expect(h.molab.docs.get(path)!.body).toContain("**conclude** Blocky wins under CG: sigma ratio 1.4, CI separated");
    expect(closed.state).toBe("done");
    expect(closed.approvals.map(({ gate, target, by }) => ({ gate, target, by }))).toEqual([
      { gate: "plan", target: planPath, by: "roykid" },
      { gate: "dry_run", target: "experiments/screen-1", by: "roykid" },
      { gate: "results", target: reportPath, by: "roykid" },
    ]);
  });

  it("reads the served scope through molab's scoped context", async () => {
    await openDelegation();
    h.molab.seedRun();
    const context = await h.tool("research_context").execute({ query: "conductivity" }, exec());
    expect(context.text).toContain("Served scope: project Polymer (molab:project/P1)");
    expect(context.text).toContain("Screen");
    expect(context.text).toContain("knowledges/sequence-study.md");
    expect(h.molab.requests).toContain("GET /api/workspace/context");
  });

  it("revises the one plan in place: a reason is required, the approval is withdrawn, a retry changes nothing", async () => {
    const path = await openDelegation();
    const args = { delegation: path, name: "Screen plan", hypothesis: "h", comparison: "c", fixed: [], varied: [], runs: "r", judgement: "j", products: [], parameters: [], no_parameters_reason: "none to fix" };
    const first = await h.tool("research_plan").execute(args, exec());
    const plan = (first.meta as { plan: { relPath: string } }).plan.relPath;
    expect(plan).toBe("knowledges/screen-plan.md");
    await h.tool("research_resume").execute({ delegation: path, answers: `批准 ${plan}`, by: "roykid", approve: { gate: "plan", target: plan } }, exec());
    // The same plan again is a retry: no reason needed, nothing rewritten, still approved.
    const retried = await h.tool("research_plan").execute(args, exec());
    expect(retried.text).toContain("Next: research_dispatch");
    expect(h.molab.rewrites).toEqual([]);
    // A change needs a reason, rewrites the same document, and needs approval again.
    const changed = { ...args, judgement: "j, with a 5% tolerance" };
    await expect(h.tool("research_plan").execute(changed, exec())).rejects.toThrow(/reason/);
    const revised = await h.tool("research_plan").execute({ ...changed, reason: "tolerance was too loose" }, exec());
    expect((revised.meta as { plan: { relPath: string } }).plan.relPath).toBe(plan);
    expect(revised.text).toContain("revised in place");
    expect(h.molab.rewrites).toEqual([plan]);
    expect(h.molab.docs.get(plan)!.body).toContain("## Why this revision\n\ntolerance was too loose");
    expect(h.molab.docs.get(plan)!.body).toContain("5% tolerance");
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Plan")).toHaveLength(1);
    const record = (await h.deps.store.get(path)).record;
    expect(record).toMatchObject({ state: "blocked", current_plan: plan, questions: [expect.stringContaining(`[gate:plan target:${plan}]`)] });
    expect(record.approvals).toEqual([]);
  });

  it("a plan under another name replaces the old document, which is deleted", async () => {
    const path = await openDelegation();
    const args = { delegation: path, hypothesis: "h", comparison: "c", fixed: [], varied: [], runs: "r", judgement: "j", products: [], parameters: [], no_parameters_reason: "none to fix" };
    const first = await h.tool("research_plan").execute({ ...args, name: "Screen plan" }, exec());
    const old = (first.meta as { plan: { relPath: string } }).plan.relPath;
    await h.tool("research_resume").execute({ delegation: path, answers: `批准 ${old}`, by: "roykid", approve: { gate: "plan", target: old } }, exec());
    const second = await h.tool("research_plan").execute({ ...args, name: "Sequence screen", reason: "renamed with a sharper comparison" }, exec());
    const now = (second.meta as { plan: { relPath: string } }).plan.relPath;
    expect(second.text).toContain(`replaces ${old}, now deleted`);
    expect(h.molab.deleted).toEqual([old]);
    expect(h.molab.docs.has(old)).toBe(false);
    const record = (await h.deps.store.get(path)).record;
    expect(record.current_plan).toBe(now);
    expect(record.approvals).toEqual([]);
  });

  it("a lost submit response is found again by its request key, never resubmitted", async () => {
    const path = await openDelegation();
    const { experiment, run } = h.molab.seedRun();
    await approved(path, "dry_run", "experiments/screen-1");
    h.molab.loseNextResponse(/^POST .*\/executions$/);
    await expect(h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, onResolve: "assess" }, exec())).rejects.toThrow(/cannot reach molab/);
    expect(h.molab.executions.get(run)).toHaveLength(1);

    const stored = await h.deps.store.get(path);
    expect(stored.record.waits[0]!.target).toBe(`molab:experiment/${experiment}/run/${run}`);
    const reconciled = await reconcile(h.deps.molab, stored.record);
    expect(reconciled.observations[0]!.kind).toBe("running");
    expect(reconciled.record.waits[0]!.target).toBe(`molab:experiment/${experiment}/run/${run}/execution/e01`);

    await h.tool("research_status").execute({ delegation: path }, exec());
    expect((await h.deps.store.get(path)).record.waits[0]!.target).toMatch(/execution\/e01$/);
    expect(h.molab.executions.get(run)).toHaveLength(1);
  });

  it("retries a record write after a concurrent change", async () => {
    const path = await openDelegation();
    h.molab.conflictNext();
    const paused = await h.tool("research_pause").execute({ delegation: path }, exec());
    expect((paused.meta as { record: { state: string } }).record.state).toBe("paused");
    await expect(h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment: "E", run: "R", onResolve: "x" }, exec())).rejects.toThrow(/paused/);
  });

  it("refuses an action the delegation was not granted, and an exhausted budget", async () => {
    const path = await openDelegation(["read", "start_execution"], { executions: 1 });
    const { experiment, run } = h.molab.seedRun();
    await approved(path, "dry_run", "experiments/screen-1");
    await expect(h.tool("molab_create_run").execute({ delegation: path, project: "P1", experiment, params: {} }, exec())).rejects.toThrow(/create_run/);
    await h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, onResolve: "x" }, exec());
    await expect(h.tool("molab_start_execution").execute({ delegation: path, project: "P1", experiment, run, onResolve: "x" }, exec())).rejects.toThrow(/budget exhausted/);
  });

});

describe("records a person and a reviewer can trust", () => {
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.molab.close();
  });

  it("files a Markdown Report under a stable name, citing molab refs, and rewrites it in place", async () => {
    const path = await openDelegation();
    h.molab.plantFile("experiments/screen/scratch/analysis.md");
    const args = {
      delegation: path,
      name: "Fragment analysis",
      summary: "Five fragments confirmed.",
      body: "## Method\n\nDetails.",
      evidence: ["molab:asset/A1", "experiments/screen/scratch/analysis.md"],
      structures: ["molab:asset/A1"],
    };
    const first = await h.tool("research_report").execute(args, exec());
    const report = (first.meta as { report: { relPath: string } }).report.relPath;
    expect(report).toBe("knowledges/fragment-analysis.md");
    const doc = h.molab.docs.get(report)!;
    expect(doc.sources).toEqual([
      { kind: "asset", ref: "molab:asset/A1" },
      { kind: "file", ref: "experiments/screen/scratch/analysis.md" },
    ]);
    expect(doc.record).toEqual({ delegation: path, summary: "Five fragments confirmed.", structures: ["molab:asset/A1"] });
    expect(doc.body).toBe(
      [
        "# Fragment analysis",
        "",
        "Five fragments confirmed.",
        "",
        "## Structures",
        "",
        "- [molab:asset/A1](molab:asset/A1)",
        "",
        "## Method",
        "",
        "Details.",
        "",
        "## Evidence",
        "",
        "- [molab:asset/A1](molab:asset/A1)",
        "- `experiments/screen/scratch/analysis.md`",
        "",
        `Delegation: \`${path}\``,
        "",
      ].join("\n"),
    );
    const again = await h.tool("research_report").execute({ ...args, summary: "Five fragments confirmed; one corrected." }, exec());
    expect(again.text).toContain("rewritten in place");
    expect(h.molab.docs.get(report)!.body).toContain("one corrected");
    expect([...h.molab.docs.values()].filter((item) => item.cls === "Report")).toHaveLength(1);
  });

  it("a new report on the same host replaces the delegation's last one, which is deleted", async () => {
    const path = await openDelegation();
    const first = await h.tool("research_report").execute({ delegation: path, name: "Crosslink boxes", summary: "s", body: "b", evidence: ["molab:asset/A1"] }, exec());
    const old = (first.meta as { report: { relPath: string } }).report.relPath;
    const second = await h.tool("research_report").execute({ delegation: path, name: "Crosslinked periodic networks", summary: "s2", body: "b2", evidence: ["molab:asset/A2"] }, exec());
    const now = (second.meta as { report: { relPath: string } }).report.relPath;
    expect(second.text).toContain(`replaces ${old}, now deleted`);
    expect(h.molab.docs.has(old)).toBe(false);
    expect(h.molab.docs.has(now)).toBe(true);
    // Another host keeps its own report.
    await h.tool("research_report").execute({ delegation: path, name: "Chain build", summary: "s", body: "b", evidence: ["molab:asset/A3"], host: "experiments/chain" }, exec());
    expect(h.molab.docs.has(now)).toBe(true);
  });

  it("refuses a report without a molab ref, with a link to this machine, with HTML, or with a structure that is not an asset", async () => {
    const path = await openDelegation();
    const base = { delegation: path, name: "R", summary: "s", body: "b", evidence: ["molab:asset/A1"] };
    await expect(h.tool("research_report").execute({ ...base, evidence: ["experiments/x/scratch/a.md"] }, exec())).rejects.toThrow(/at least one molab: ref/);
    await expect(h.tool("research_report").execute({ ...base, body: "See http://127.0.0.1:8771/junction-bonds.html" }, exec())).rejects.toThrow(/localhost/);
    await expect(h.tool("research_report").execute({ ...base, body: "view at localhost:5173/?session=x" }, exec())).rejects.toThrow(/localhost/);
    await expect(h.tool("research_report").execute({ ...base, body: '<iframe src="x"></iframe>' }, exec())).rejects.toThrow(/Markdown/);
    await expect(h.tool("research_report").execute({ ...base, structures: ["experiments/x/out/network.data"] }, exec())).rejects.toThrow(/molab:asset/);
    expect([...h.molab.docs.values()].filter((item) => item.cls === "Report")).toEqual([]);
  });

  it("asks a person instead of stopping, and keeps the decision and the answer on the delegation", async () => {
    const path = await openDelegation();
    await expect(h.tool("research_decide").execute({ delegation: path, name: "Need structures", decision: "ask_human", reason: "h-type bridge unclear", evidence: [path] }, exec())).rejects.toThrow(/questions/);
    const asked = await h.tool("research_decide").execute(
      { delegation: path, name: "Need structures", decision: "ask_human", reason: "h-type bridge unclear", evidence: [path], questions: ["Q1: bridge connectivity?"] },
      exec(),
    );
    expect(asked.text).toContain("blocked");
    await expect(h.tool("research_plan").execute({ delegation: path, name: "p", hypothesis: "h", comparison: "c", fixed: [], varied: [], runs: "r", judgement: "j", products: [] }, exec())).rejects.toThrow(/blocked on a person: Q1/);
    const resumed = await h.tool("research_resume").execute({ delegation: path, answers: "Q1: piperidinium, n=3", by: "collaborator" }, exec());
    expect(resumed.text).toContain("open again");
    const record = (await h.deps.store.get(path)).record;
    expect(record.state).toBe("open");
    expect(record.questions).toEqual([]);
    expect(record.answers).toEqual([{ path, by: "collaborator", text: "Q1: piperidinium, n=3" }]);
    expect(record.approvals).toEqual([]);
    expect(record.decisions).toEqual([
      { at: "2026-11-03T12:00:00.000Z", name: "Need structures", kind: "ask_human", reason: "h-type bridge unclear", evidence: [path], questions: ["Q1: bridge connectivity?"] },
    ]);
    const status = await h.tool("research_status").execute({ delegation: path }, exec());
    expect(status.text).toContain("Last decision: ask_human: Need structures");
    expect(status.text).toContain(`- collaborator (${path}): Q1: piperidinium, n=3`);
    expect(status.text).toContain("Acceptance:\n- 3 seeds per sequence");
    // Neither the decision nor the answer is a document of its own.
    expect([...h.molab.docs.keys()]).toEqual([path]);
    await h.tool("research_decide").execute({ delegation: path, name: "Need n", decision: "ask_human", reason: "n unclear", evidence: [path], questions: ["Q2: n?"] }, exec());
    await h.tool("research_resume").execute({ delegation: path, answers: "Q2: n=4", by: "collaborator" }, exec());
    expect((await h.deps.store.get(path)).record.answers.map((answer) => answer.text)).toEqual(["Q1: piperidinium, n=3", "Q2: n=4"]);
    await expect(h.tool("research_resume").execute({ delegation: path, answers: "x" }, exec())).rejects.toThrow(/only a blocked or paused one resumes/);
  });

  it("a repeated decision is one log entry", async () => {
    const path = await openDelegation();
    const args = { delegation: path, name: "Go on", decision: "continue", reason: "on track", evidence: [path] };
    await h.tool("research_decide").execute(args, exec());
    await h.tool("research_decide").execute(args, exec());
    expect((await h.deps.store.get(path)).record.decisions).toHaveLength(1);
  });

  it("keeps a long answer on the delegation, clipped", async () => {
    const path = await openDelegation();
    await h.tool("research_decide").execute({ delegation: path, name: "Q", decision: "ask_human", reason: "r", evidence: [path], questions: ["q"] }, exec());
    await h.tool("research_resume").execute({ delegation: path, answers: "x".repeat(2400), by: "collaborator" }, exec());
    const record = (await h.deps.store.get(path)).record;
    expect(record.answers[0]!.text).toHaveLength(2000);
    expect(record.answers[0]!.text.endsWith("…")).toBe(true);
  });

  it("deletes its own record on retraction, and refuses someone else's", async () => {
    const path = await openDelegation();
    const written = await h.tool("research_report").execute({ delegation: path, name: "Wrong", summary: "s", body: "b", evidence: ["molab:asset/A1"] }, exec());
    const doc = (written.meta as { report: { relPath: string } }).report.relPath;
    await h.tool("research_retract").execute({ delegation: path, path: doc, reason: "written twice" }, exec());
    expect(h.molab.docs.has(doc)).toBe(false);
    expect((await h.deps.store.get(path)).record.writes.map((write) => write.path)).not.toContain(doc);
    expect(h.molab.docs.get(path)!.body).toContain("written twice");
    h.molab.plantDoc("knowledges/theirs.md", { cls: "Observation", record: { delegation: "knowledges/other.md" } });
    await expect(h.tool("research_retract").execute({ delegation: path, path: "knowledges/theirs.md", reason: "x" }, exec())).rejects.toThrow(/not yours/);
  });
});

describe("a workspace Tack did not write", () => {
  beforeEach(async () => {
    h = await harness();
    h.molab.plantDoc("knowledges/pbix-plan.md", { cls: "Plan", body: "# PBIX AEM modeling plan\nExecute from this plan." });
    h.molab.plantDoc("knowledges/pbix-roadmap.md", {
      cls: "Roadmap",
      record: { stages: [{ id: "monomers", title: "Confirm fragments", experiment: "monomers" }, { id: "stage1", title: "Equilibrate", experiment: "stage1-equilibrate", depends_on: ["monomers"] }] },
    });
    h.molab.plantDoc("knowledges/pbix-todo.md", {
      cls: "Todo",
      record: { items: [{ id: "confirm", title: "Confirm bond orders", status: "open", stage: "monomers" }, { id: "build", title: "Build fragments", status: "blocked", stage: "monomers" }] },
    });
    h.molab.plantDoc("knowledges/monomers-confirmed.md", { cls: "Milestone", record: { stage: "monomers", criterion: "seven fragments match", status: "open" } });
    h.molab.plantDoc("knowledges/broken-roadmap.md", { cls: "Roadmap", record: { stages: "not a list" } });
    h.molab.plantDoc("knowledges/old-work.md", { cls: "Delegation", record: { goal: "left by hand" } });
    h.molab.plantDoc("knowledges/chose-ff.md", { cls: "Observation", record: { decision: { kind: "pick_forcefield", reason: "" } } });
    h.molab.plantDoc("knowledges/note.md", { cls: "Observation", record: {} });
    h.molab.violations = [
      { path: "projects/p/experiments/monomers", rule: "experiment.absolute_entrypoint", detail: "workflow_entrypoint is absolute", severity: "warning", hint: "rebind relative" },
      { path: "knowledges/old-work.md", rule: "knowledge.record", detail: "a Delegation stores its goal and its scope", severity: "error", hint: "rewrite it" },
    ];
  });
  afterEach(async () => {
    await h.molab.close();
  });

  it("reads the existing campaign into the context", async () => {
    const context = await h.tool("research_context").execute({}, exec());
    expect(context.text).toContain("Plan knowledges/pbix-plan.md: # PBIX AEM modeling plan");
    expect(context.text).toContain("stage1: Equilibrate → experiment stage1-equilibrate after monomers");
    expect(context.text).toContain("[blocked] build (monomers): Build fragments");
    expect(context.text).toContain("Milestone knowledges/monomers-confirmed.md [open] closes monomers");
    expect(context.text).toContain("Unreadable knowledges/broken-roadmap.md");
  });

  it("lists a Delegation it cannot read instead of failing, and the watcher skips it", async () => {
    const status = await h.tool("research_status").execute({}, exec());
    expect(status.text).toContain("knowledges/old-work.md: cannot be read");
    await h.watcher.tick();
    expect(h.wakes).toHaveLength(0);
  });

  it("audits molab's rules and Tack's conventions without writing anything", async () => {
    const before = JSON.stringify([...h.molab.docs.entries()]);
    const audit = await h.tool("research_audit").execute({}, exec());
    expect(audit.text).toMatch(/^Audit of .*: 2 error\(s\), 2 warning\(s\)\./);
    expect(audit.text).toContain("ERROR knowledge.record (1)");
    expect(audit.text).toContain("ERROR tack.delegation_unreadable (1)");
    expect(audit.text).toContain("WARNING experiment.absolute_entrypoint (1)");
    expect(audit.text).toContain("fix: rebind relative");
    expect(audit.text).toContain("WARNING tack.decision_document (1)");
    expect(audit.text).toContain("knowledges/chose-ff.md: an Observation holding a decision");
    expect(audit.text).not.toContain("knowledges/note.md");
    expect(audit.text.indexOf("ERROR")).toBeLessThan(audit.text.indexOf("WARNING"));
    expect(JSON.stringify([...h.molab.docs.entries()])).toBe(before);
    expect(h.molab.requests.every((request) => request.startsWith("GET "))).toBe(true);

    const errorsOnly = await h.tool("research_audit").execute({ errorsOnly: true }, exec());
    expect(errorsOnly.text).not.toContain("WARNING");
  });

  it("opens a delegation under the existing Plan", async () => {
    const opened = await h.tool("research_open").execute(
      { name: "Monomers", goal: "Confirm the seven fragments", actions: ["read", "delegate_worker", "write_knowledge"], plan: "knowledges/pbix-plan.md" },
      exec(),
    );
    expect((opened.meta as { record: { current_plan: string } }).record.current_plan).toBe("knowledges/pbix-plan.md");
    await expect(
      h.tool("research_open").execute({ name: "Bad", goal: "g", actions: ["read"], plan: "knowledges/pbix-todo.md" }, exec()),
    ).rejects.toThrow(/is a Todo, not a Plan/);
  });
});
