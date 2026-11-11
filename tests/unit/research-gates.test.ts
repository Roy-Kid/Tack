/**
 * The human gates: approvals on the Delegation record and the gate marker on
 * a blocking question; the four gates as the tools enforce them (an
 * uncertain parameter refuses the plan, the plan blocks for approval, a
 * worker runs in draft mode and cannot execute before the dry run is
 * approved, a conclusion waits for the results approval); the caller
 * identity behind every answer; and the TACK-GATE trailer a headless run
 * prints. With the gates off, the old flow.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { userInfo } from "node:os";
import { parseConfig } from "../../packages/research/src/config.js";
import { approve, block, coveringApproval, DelegationRecord, isApproved, markGate, parseGate, parseRecord, pendingGate, requireApproved, toWire } from "../../packages/research/src/delegation/model.js";
import { renderStatus } from "../../packages/research/src/delegation/status.js";
import { callerIdentity } from "../../packages/research/src/dsh/adapter.js";
import { dryRunOpen, executionOf, gateTrailer, renderTrailer, runsMolab } from "../../packages/research/src/gates.js";
import { resumeBrief } from "../../packages/research/src/reconcile.js";
import { workerRefusal } from "../../packages/research/src/workers.js";
import { type Call, CALLER, NOW, researchHarness, type ResearchHarness, sampleReport } from "../research-harness.js";

const PLAN = "knowledges/plan-v1.md";
const D = "knowledges/d.md";
const base = () => DelegationRecord.parse({ goal: "g", scope: "molab:project/P1", actions: ["read", "write_knowledge", "delegate_worker", "start_execution"], current_plan: PLAN });
const stamp = { by: "roykid", at: NOW };

describe("approvals on the record", () => {
  it("records an approval, finds it by gate and target, and refuses a step before it", () => {
    const record = base();
    expect(isApproved(record, "plan", PLAN)).toBe(false);
    expect(() => requireApproved(record, "plan", PLAN)).toThrow(/plan gate is pending for knowledges\/plan-v1\.md: a person must approve it[\s\S]*ask_human[\s\S]*next round[\s\S]*research_resume\(approve/);
    const approved = approve(record, { gate: "plan", target: PLAN, ...stamp, note: "knowledges/answer.md" });
    expect(record.approvals).toEqual([]);
    expect(isApproved(approved, "plan", PLAN)).toBe(true);
    expect(isApproved(approved, "plan", "knowledges/plan-v2.md")).toBe(false);
    expect(isApproved(approved, "dry_run", PLAN)).toBe(false);
    expect(() => requireApproved(approved, "plan", PLAN)).not.toThrow();
    expect(() => approve(record, { gate: "launch", target: PLAN, ...stamp } as never)).toThrow(/invalid approval/);
    expect(parseRecord({ ...toWire(approved), class: "Delegation" }).approvals).toEqual([{ gate: "plan", target: PLAN, ...stamp, note: "knowledges/answer.md" }]);
    expect(parseRecord(toWire(record)).approvals).toEqual([]);
  });

  it("a dry-run approval covers its experiment and the workflow under it", () => {
    const record = approve(base(), { gate: "dry_run", target: "experiments/chain/workflow.py", ...stamp });
    expect(coveringApproval(record, "dry_run", "experiments/chain/workflow.py")?.target).toBe("experiments/chain/workflow.py");
    expect(coveringApproval(record, "dry_run", "experiments/chain")?.target).toBe("experiments/chain/workflow.py");
    expect(coveringApproval(record, "dry_run", "experiments/chain-2")).toBeUndefined();
    expect(coveringApproval(record, "dry_run", "experiments/other/workflow.py")).toBeUndefined();
    expect(coveringApproval(record, "plan", "experiments/chain")).toBeUndefined();
    const byExperiment = approve(base(), { gate: "dry_run", target: "experiments/chain", ...stamp });
    expect(coveringApproval(byExperiment, "dry_run", "experiments/chain/workflow.py")?.target).toBe("experiments/chain");
    expect(dryRunOpen(record)).toBe(true);
    expect(dryRunOpen(base())).toBe(false);
  });

  it("marks the gate on a blocking question and reads it back", () => {
    expect(markGate({ gate: "plan", target: PLAN }, ["Approve?", "Also?"])).toEqual([`[gate:plan target:${PLAN}] Approve?`, "Also?"]);
    expect(markGate({ gate: "results", target: "k/a.md" }, ["[gate:plan target:x] Approve?"])).toEqual(["[gate:results target:k/a.md] Approve?"]);
    expect(() => markGate({ gate: "plan", target: "a path" }, ["q"])).toThrow(/without spaces/);
    expect(() => markGate({ gate: "plan", target: PLAN }, [])).toThrow(/needs the question/);
    expect(parseGate("[gate:dry_run target:experiments/chain] Run it?")).toEqual({ ref: { gate: "dry_run", target: "experiments/chain" }, question: "Run it?" });
    expect(parseGate("Plain?")).toBeUndefined();
    const blocked = block(base(), ["Approve this plan?"], { gate: "plan", target: PLAN });
    expect(blocked.state).toBe("blocked");
    expect(blocked.questions).toEqual([`[gate:plan target:${PLAN}] Approve this plan?`]);
    expect(pendingGate(blocked)).toEqual({ gate: "plan", target: PLAN });
    expect(pendingGate(block(base(), ["Which basis set?"]))).toBeUndefined();
    expect(pendingGate(base())).toBeUndefined();
  });

  it("shows the person, the pending gate and the approvals in the brief and the status", () => {
    const record = approve(block(base(), ["Approve this plan?"], { gate: "plan", target: PLAN }), { gate: "parameters", target: D, ...stamp });
    const brief = resumeBrief(D, { record, observations: [], changed: false });
    expect(brief).toContain(
      `Waiting on a person (gate plan, target ${PLAN}); their answer arrives as the next prompt. Record it with research_resume (approve: {gate: "plan", target: "${PLAN}"} only when they clearly approved that target), then continue:\n- [gate:plan target:${PLAN}] Approve this plan?`,
    );
    expect(brief).toContain(`Approvals:\n- parameters ${D} by roykid at ${NOW}`);
    const status = renderStatus("d", record);
    expect(status).toContain(`**Waiting on a person:** a person: gate plan for ${PLAN} — [gate:plan target:${PLAN}] Approve this plan?`);
    expect(status).toContain(`## Approvals\n\n- parameters ${D} by roykid at ${NOW}`);
    expect(resumeBrief(D, { record: base(), observations: [], changed: false })).toContain("Waiting on a person: no.\n\nAnswers from people: none.\n\nApprovals: none yet.");
    expect(renderStatus("d", base())).toContain("**Waiting on a person:** nobody");
  });

  it("the plan gate refuses a worker before the current plan is approved, and only with the gate on", () => {
    const gates = parseConfig({}).gates;
    expect(workerRefusal(base(), D, 0, gates)).toMatch(/plan gate is pending for knowledges\/plan-v1\.md/);
    expect(workerRefusal({ ...base(), current_plan: undefined }, D, 0, gates)).toMatch(/no plan is recorded yet/);
    expect(workerRefusal(approve(base(), { gate: "plan", target: PLAN, ...stamp }), D, 0, gates)).toBeUndefined();
    expect(workerRefusal(base(), D, 0, { ...gates, plan: false })).toBeUndefined();
    expect(workerRefusal(base(), D)).toBeUndefined();
  });
});

describe("gates config, shell checks, trailer and caller", () => {
  it("defaults every gate on and takes each off separately", () => {
    expect(parseConfig({}).gates).toEqual({ parameters: true, plan: true, dryRun: true, results: true });
    expect(parseConfig({ gates: { dryRun: false } }).gates).toEqual({ parameters: true, plan: true, dryRun: false, results: true });
    expect(() => parseConfig({ gates: { launch: true } })).toThrow(/invalid config/);
  });

  it("tells `molab run` (even --dry-run) from the `molab workflow dry-run` preview in a shell command", () => {
    for (const command of [
      "molab run workflow.py",
      "molab run --dry-run workflow.py",
      "cd experiments/chain && molab run workflow.py --target local",
      "uv run molab run workflow.py",
      "/opt/venv/bin/molab run x.py",
      "molab workflow dry-run x.py --json; molab run x.py",
    ]) {
      expect(runsMolab(command), command).toBe(true);
    }
    for (const command of ["molab workflow dry-run workflow.py --json", "python workflow.py", "molab validate", "molab knowledge write a b", ""]) {
      expect(runsMolab(command), command).toBe(false);
    }
    expect(executionOf("molab_start_execution", {})).toBe("molab_start_execution");
    expect(executionOf("bash", { command: "molab run x.py" })).toBe("molab run x.py");
    expect(executionOf("bash", { command: "molab workflow dry-run x.py --json" })).toBeUndefined();
    expect(executionOf("read", { file_path: "x" })).toBeUndefined();
  });

  it("renders the trailer a headless run prints for a blocked delegation", () => {
    const record = block(base(), ["Approve this plan?", "Seeds?"], { gate: "plan", target: PLAN });
    const trailer = gateTrailer(D, record)!;
    expect(trailer).toEqual({ delegation: D, state: "blocked", gate: "plan", target: PLAN, questions: ["Approve this plan?", "Seeds?"] });
    expect(renderTrailer(trailer)).toBe(`TACK-GATE\n${JSON.stringify(trailer)}\n`);
    expect(gateTrailer(D, base())).toBeUndefined();
    expect(gateTrailer(D, block(base(), ["Which basis set?"]))).toEqual({ delegation: D, state: "blocked", questions: ["Which basis set?"] });
  });

  it("the caller identity is TACK_BY, else the OS user; never an argument", () => {
    expect(callerIdentity({ TACK_BY: "alice" })).toBe("alice");
    expect(callerIdentity({ TACK_BY: " " })).toBe(userInfo().username);
    expect(callerIdentity({})).toBe(userInfo().username);
  });
});

describe("the four gates in the tools", () => {
  let h: ResearchHarness;
  const PARAMS = [
    { name: "temperature", value: "400 K", source: "human" },
    { name: "timestep", value: "2 fs", source: "default" },
  ];
  const planArgs = (path: string, over: Record<string, unknown> = {}) => ({
    delegation: path,
    name: "Chain plan",
    hypothesis: "h",
    comparison: "c",
    fixed: [],
    varied: [],
    runs: "r",
    judgement: "j",
    products: ["p"],
    parameters: PARAMS,
    ...over,
  });
  const dispatch = (path: string, over: Record<string, unknown> = {}) =>
    h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Write the workflow", task: "Write workflow.py.", expected: ["workflow.py"], ...over });
  const child = (name: string, args: Record<string, unknown>): Call => ({ name, arguments: args, agent: { session: { id: "child-1", header: { origin: "subagent", parentSession: "S1" } } } });
  const conclude = (path: string) => ({ delegation: path, name: "Done", decision: "conclude", reason: "r", evidence: [path], finding: { name: "F", statement: "s", scope: "c", host: "experiments/chain" } });
  const settled = () => new Promise((done) => setTimeout(done, 50));

  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("gate 1: a plan with an uncertain parameter is refused, and the parameters are required", async () => {
    const path = await h.open({ plan: false });
    await expect(h.call("research_plan", planArgs(path, { parameters: [...PARAMS, { name: "force field", value: "OPLS-AA", source: "default", uncertain: true }] }))).rejects.toThrow(
      /uncertain parameter force field: ask the person first \(research_decide ask_human/,
    );
    await expect(h.call("research_plan", planArgs(path, { parameters: [] }))).rejects.toThrow(/no_parameters_reason/);
    // DSH's schema refuses an unknown source before the tool runs; a direct call hits the tool's own validation.
    await expect(h.call("research_plan", planArgs(path, { parameters: [{ name: "x", value: "1", source: "guess" }] }))).rejects.toThrow(/parameters\[0\]\.source|invalid parameters/);
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Plan")).toHaveLength(0);
    expect((await h.record(path)).state).toBe("open");
  });

  it("gate 2: the written plan blocks the delegation until a person approves it; a revision needs approval again", async () => {
    const path = await h.open({ plan: false });
    const planned = await h.call("research_plan", planArgs(path));
    const plan = (planned.meta as { plan: { relPath: string } }).plan.relPath;
    expect(planned.text).toContain("waits for a person's approval (gate plan)");
    const doc = h.molab.docs.get(plan)!;
    expect(doc.body).toContain("| temperature | 400 K | human | yes |  |");
    expect(doc.record.parameters).toEqual([
      { name: "temperature", value: "400 K", source: "human", uncertain: false },
      { name: "timestep", value: "2 fs", source: "default", uncertain: false },
    ]);
    let record = await h.record(path);
    expect(record.state).toBe("blocked");
    expect(record.questions).toEqual([`[gate:plan target:${plan}] Approve this plan? Answer 'approve ${plan}', or list the changes it needs.`]);
    expect(h.molab.docs.get(path)!.body).toContain(`**Waiting on a person:** a person: gate plan for ${plan}`);
    await expect(dispatch(path)).rejects.toThrow(/blocked on a person: \[gate:plan/);
    // The person's words, recorded by the supervisor; the approval is by the caller, whatever `by` the model passes.
    const resumed = await h.call("research_resume", { delegation: path, answers: `批准 ${plan}`, by: "the-model-says", approve: { gate: "plan", target: plan } });
    expect(resumed.text).toContain(`plan approved for ${plan} by ${CALLER}`);
    record = await h.record(path);
    expect(record.state).toBe("open");
    expect(record.approvals).toEqual([{ gate: "plan", target: plan, by: CALLER, at: NOW, note: `批准 ${plan}` }]);
    expect(record.answers[0]).toMatchObject({ by: CALLER, text: `批准 ${plan}` });
    expect((await dispatch(path)).text).toContain("mode draft");
    // A revision of the plan: the approval of what it said no longer applies.
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settled();
    const revised = await h.call("research_plan", planArgs(path, { judgement: "within 5%", reason: "tolerance" }));
    expect((revised.meta as { plan: { relPath: string } }).plan.relPath).toBe(plan);
    expect((await h.record(path)).state).toBe("blocked");
    await h.call("research_resume", { delegation: path, answers: "change the tolerance to 5%" });
    expect((await h.record(path)).approvals).toEqual([]);
    await expect(dispatch(path, { task: "Again." })).rejects.toThrow(new RegExp(`plan gate is pending for ${plan}`));
  });

  it("gate 3: a run round, the supervisor's execution and a worker's `molab run` wait for the dry-run approval", async () => {
    const path = await h.open();
    const { experiment, run } = h.molab.seedRun();
    const draft = await dispatch(path);
    expect(draft.text).toContain("mode draft");
    expect(draft.text).toContain("ask the person to approve the dry run");
    const prompt = h.workers.starts[0]!.request.prompt;
    expect(prompt).toContain("## Mode: draft (nothing executes this round)");
    expect(prompt).toContain("molab_dry_run(delegation, experiment)");
    expect(prompt).toContain("product of kind dry_run");
    await expect(dispatch(path, { mode: "run", task: "Run it." })).rejects.toThrow(/mode run needs the workflow whose dry run a person approved/);
    // The worker session may preview but not execute (nor create runs).
    for (const call of [
      child("bash", { command: "molab workflow dry-run experiments/chain/workflow.py --json" }),
      child("bash", { command: "python experiments/chain/scratch/probe.py" }),
      child("molab_dry_run", { delegation: path, experiment }),
    ]) {
      expect((await h.pre(call)).kind, JSON.stringify(call.arguments)).toBe("allow");
    }
    for (const call of [
      child("bash", { command: "molab run experiments/chain/workflow.py" }),
      child("bash", { command: "molab run --dry-run experiments/chain/workflow.py" }),
      child("bash", { command: "cd experiments/chain && uv run molab run workflow.py" }),
      child("molab_start_execution", { delegation: path, project: "P1", experiment, run, onResolve: "x" }),
    ]) {
      const decision = await h.pre(call);
      expect(decision.kind, JSON.stringify(call.arguments)).toBe("deny");
      if (decision.kind !== "deny") continue;
      expect(decision.info).toEqual({ name: "TackGateDryRun", code: "TACK_GATE_DRYRUN" });
      expect(decision.reason).toContain(`before a person approved the dry run (gate dry_run of delegation ${path})`);
    }
    // The supervisor's own execution is gated on the experiment's path.
    await expect(h.call("molab_start_execution", { delegation: path, project: "P1", experiment, run, onResolve: "assess" })).rejects.toThrow(/dry_run gate is pending for experiments\/screen-1/);
    expect(h.molab.executions.get(run)).toHaveLength(0);
    // molab_dry_run: nothing stored yet, a workflow that does not compile, then the compiled waves.
    await expect(h.call("molab_dry_run", { delegation: path, experiment })).rejects.toThrow(/no workflow is stored for experiment E1 yet/);
    h.molab.dryRun(experiment, { status: 400, body: { detail: "NameError: tsk" } });
    await expect(h.call("molab_dry_run", { delegation: path, experiment })).rejects.toThrow(/does not compile: NameError: tsk/);
    h.molab.dryRun(experiment, {
      body: {
        experiment: { id: experiment, name: "Screen 1", path: "experiments/screen-1" },
        workflow: { name: "chain" },
        waves: [["build", "solvate"], ["equilibrate"]],
        branches: [{ source: "build", label: "ok", target: "solvate" }],
        runs: [{ params: { seq: "ABAB", seed: 1 } }],
        tasks: [{ name: "build", dependsOn: [] }],
      },
    });
    const dry = await h.call("molab_dry_run", { delegation: path, experiment });
    expect(dry.text).toContain("Dry run of workflow chain for experiment Screen 1 (E1, experiments/screen-1): 2 wave(s), 1 run(s), 1 branch(es). Nothing was executed.");
    expect(dry.text).toContain("- wave 1: build, solvate\n- wave 2: equilibrate");
    expect(dry.text).toContain("- build → solvate (ok)");
    expect(dry.text).toContain('gate: {gate: "dry_run", target: "experiments/screen-1"}');
    expect(h.molab.requests).toContain("GET /api/projects/-/experiments/E1/workflow/dry-run");
    // The worker reports; the person approves; the run round and the execution go through.
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport({ workflow: "experiments/screen-1/workflow.py", products: [{ path: "experiments/screen-1/scratch/dry-run.json", kind: "dry_run", description: "2 waves" }] }) });
    await settled();
    const asked = await h.call("research_decide", {
      delegation: path,
      name: "Run the waves?",
      decision: "ask_human",
      reason: "dry run compiled",
      evidence: [path],
      gate: { gate: "dry_run", target: "experiments/screen-1" },
      questions: ["Execute wave 1 (build, solvate) and wave 2 (equilibrate) for seq=ABAB seed=1?"],
    });
    expect(asked.text).toContain('record it with research_resume (approve: {gate: "dry_run", target: "experiments/screen-1"} only if they approved it)');
    expect((await h.record(path)).questions[0]).toBe("[gate:dry_run target:experiments/screen-1] Execute wave 1 (build, solvate) and wave 2 (equilibrate) for seq=ABAB seed=1?");
    await h.approve(path, "dry_run", "experiments/screen-1");
    const second = await dispatch(path, { task: "Run it." });
    expect(second.text).toContain("mode run");
    expect(h.workers.starts[1]!.request.prompt).toContain(`The dry run of experiments/screen-1 was approved by ${CALLER} at ${NOW}`);
    expect((await h.pre(child("bash", { command: "molab run experiments/screen-1/workflow.py" }))).kind).toBe("allow");
    expect((await h.pre(child("molab_start_execution", { delegation: path, project: "P1", experiment, run, onResolve: "x" }))).kind).toBe("allow");
    await h.call("molab_start_execution", { delegation: path, project: "P1", experiment, run, onResolve: "assess" });
    expect(h.molab.executions.get(run)).toHaveLength(1);
  });

  it("gate 4: a conclusion waits for the person's approval of the latest assessment", async () => {
    const path = await h.open();
    const { experiment, run } = h.molab.seedRun();
    await expect(h.call("research_decide", conclude(path))).rejects.toThrow(/conclude needs an assessment a person approved/);
    const target = `molab:experiment/${experiment}/run/${run}`;
    const level = { verdict: "pass", reason: "r" };
    const assessed = await h.call("research_assess", { delegation: path, target, project: "P1", name: "Seed 1", execution: level, data: level, analysis: level, conclusion: level, evidence: [target] });
    const report = (assessed.meta as { report: { relPath: string } }).report.relPath;
    expect(assessed.text).toContain(`a person approves these results before a conclusion (research_decide ask_human, gate results, target ${report}`);
    await expect(h.call("research_decide", conclude(path))).rejects.toThrow(new RegExp(`results gate is pending for ${report}`));
    await h.approve(path, "results", report);
    expect((await h.call("research_decide", conclude(path))).text).toContain("Delegation is done");
  });

  it("prints the TACK-GATE trailer for a delegation left blocked, after a turn of the session that worked on it", async () => {
    const path = await h.open({ plan: false });
    await h.turnEnd("S1");
    await h.trailer.flush();
    expect(h.trailer.writes).toEqual([]);
    const planned = await h.call("research_plan", planArgs(path));
    const plan = (planned.meta as { plan: { relPath: string } }).plan.relPath;
    await h.turnEnd("S9");
    await h.turnEnd("S1");
    await h.trailer.flush();
    const trailer = { delegation: path, state: "blocked", gate: "plan", target: plan, questions: [`Approve this plan? Answer 'approve ${plan}', or list the changes it needs.`] };
    expect(h.trailer.writes).toEqual([`TACK-GATE\n${JSON.stringify(trailer)}\n`]);
  });

  it("prints no trailer outside a headless run", async () => {
    await h.close();
    h = await researchHarness(undefined, { headless: false });
    const path = await h.open({ plan: false });
    await h.call("research_plan", planArgs(path));
    await h.turnEnd("S1");
    await h.trailer.flush();
    expect(h.trailer.writes).toEqual([]);
  });

  it("with the gates off, nothing blocks: the old flow", async () => {
    await h.close();
    h = await researchHarness(undefined, { config: { gates: { parameters: false, plan: false, dryRun: false, results: false } } });
    const path = await h.open({ plan: false });
    const planned = await h.call("research_plan", planArgs(path, { parameters: [{ name: "force field", value: "OPLS-AA", source: "default", uncertain: true }] }));
    expect(planned.text).toContain("Next: research_dispatch.");
    expect((await h.record(path)).state).toBe("open");
    expect((await dispatch(path)).text).toContain("mode run");
    expect(h.workers.starts[0]!.request.prompt).not.toContain("Mode: draft");
    const { experiment, run } = h.molab.seedRun();
    await h.call("molab_start_execution", { delegation: path, project: "P1", experiment, run, onResolve: "assess" });
    expect((await h.pre(child("bash", { command: "molab run experiments/chain/workflow.py" }))).kind).toBe("allow");
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settled();
    expect((await h.call("research_decide", conclude(path))).text).toContain("Delegation is done");
  });
});
