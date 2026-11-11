/**
 * The research plugin's pure parts: the Delegation record and its transitions,
 * the authorization policy, molab refs, and config.
 */
import { describe, expect, it } from "@rstest/core";
import { parseConfig } from "../../packages/research/src/config.js";
import {
  budgetLeft,
  DelegationRecord,
  linkReport,
  openWait,
  parseRecord,
  pendingWaits,
  recordAnswer,
  recordAttempt,
  recordDecision,
  requireActive,
  requireBudget,
  resolveWait,
  setBrief,
  settleAttempt,
  spend,
  toWire,
  transition,
} from "../../packages/research/src/delegation/model.js";
import { renderStatus } from "../../packages/research/src/delegation/status.js";
import { executionRef, parseRef, runRef, sourceKindOf } from "../../packages/research/src/molab/refs.js";
import { PolicyError, requireAction, requireSubset, withinScope } from "../../packages/research/src/policy.js";

const base = () =>
  DelegationRecord.parse({
    goal: "Does sequence order change conductivity?",
    scope: "molab:project/P1",
    actions: ["read", "start_execution", "write_knowledge"],
    budget: { executions: 2, worker_usd: 1 },
  });

describe("delegation record", () => {
  it("fills defaults for a fresh research delegation", () => {
    const record = base();
    expect(record.kind).toBe("research");
    expect(record.state).toBe("open");
    expect(record.spent.executions).toBe(0);
  });

  it("ignores common document keys and rejects unknown fields", () => {
    expect(parseRecord({ ...toWire(base()), class: "Delegation", tags: ["x"] }).goal).toMatch(/sequence/);
    expect(() => parseRecord({ ...toWire(base()), mystery: 1 })).toThrow(/invalid Delegation record/);
  });

  it("rejects an action outside the closed set", () => {
    expect(() => DelegationRecord.parse({ ...toWire(base()), actions: ["rm_rf"] })).toThrow();
  });

  it("round-trips through the wire form without nulls", () => {
    const wire = toWire(base());
    expect(JSON.stringify(wire)).not.toContain("null");
    expect(parseRecord(wire)).toEqual(base());
  });

  it("carries the brief, report and tokens of an attempt, the last decision and the answers, as molab stores them", () => {
    const digest = "f".repeat(64);
    const attempt = { id: "a1", worker: "spawn", task: "t", status: "completed", summary: "s", files_changed: [], brief: "knowledges/brief.md", brief_digest: digest, report: "knowledges/report.md", tokens: { input: 10, output: 2 } };
    const decision = { at: "2026-11-04T10:00:00Z", name: "Rebuild", kind: "fix", reason: "bridge wrong", evidence: ["knowledges/r.md"], next: "n", questions: [] };
    const record = recordAnswer(recordDecision(recordAttempt(base(), attempt), decision), { path: "knowledges/d.md", by: "roykid", text: "6 with 5" });
    const wire = toWire(record);
    expect(wire.decisions).toEqual([decision]);
    expect(wire).not.toHaveProperty("last_decision");
    expect(wire.answers).toEqual([{ path: "knowledges/d.md", by: "roykid", text: "6 with 5" }]);
    expect(parseRecord(wire)).toEqual(record);
    // molab omits empty collections; the mirror fills them back.
    const { answers: _answers, ...withoutAnswers } = toWire(base());
    expect(parseRecord(withoutAnswers).answers).toEqual([]);
    expect(() => parseRecord(toWire(recordAttempt(base(), { ...attempt, brief_digest: "abc" })))).toThrow(/64 lowercase hex/);
    expect(() => parseRecord(toWire(recordAttempt(base(), { ...attempt, tokens: "unavailable" })))).not.toThrow();
  });
});

describe("attempt links", () => {
  const started = () => recordAttempt(base(), { id: "a1", worker: "spawn", task: "t", status: "running", summary: "", files_changed: ["x.py"] });

  it("sets the brief, links a report once, and keeps a check for a missing one", () => {
    const briefed = setBrief(started(), "a1", { path: "knowledges/brief.md", digest: "e".repeat(64) });
    expect(briefed.attempts[0]).toMatchObject({ brief: "knowledges/brief.md", brief_digest: "e".repeat(64) });
    const checked = linkReport(briefed, "a1", { check: "invalid: no json block" });
    expect(checked.attempts[0]!.check).toBe("invalid: no json block");
    const linked = linkReport(checked, "a1", { report: "knowledges/r1.md", tokens: "unavailable", files_changed: ["x.py", "y.py"] });
    expect(linked.attempts[0]).toMatchObject({ report: "knowledges/r1.md", tokens: "unavailable", files_changed: ["x.py", "y.py"] });
    expect(linked.attempts[0]!.check).toBeUndefined();
    expect(linkReport(linked, "a1", { report: "knowledges/r2.md" }).attempts[0]!.report).toBe("knowledges/r1.md");
    expect(() => linkReport(linked, "nope", { check: "x" })).toThrow(/no attempt nope/);
    expect(() => setBrief(linked, "nope", { path: "p", digest: "d" })).toThrow(/no attempt nope/);
  });

  it("settles an attempt with its tokens, and never mutates its input", () => {
    const record = started();
    const frozen = JSON.stringify(record);
    const settled = settleAttempt(record, "a1", { status: "completed", summary: "done", ended_at: "2026-11-04T10:00:00Z", tokens: { input: 1, output: 1 } });
    expect(settled.attempts[0]!.tokens).toEqual({ input: 1, output: 1 });
    linkReport(record, "a1", { report: "r" });
    recordDecision(record, { at: "t", name: "n", kind: "fix", reason: "r", evidence: [], questions: [] });
    recordAnswer(record, { path: "p", by: "b", text: "t" });
    expect(JSON.stringify(record)).toBe(frozen);
  });
});

describe("transitions", () => {
  it("opening a wait parks the delegation; settling the last one reopens it", () => {
    const waiting = openWait(base(), { id: "w1", target: runRef("E1", "R1"), project: "P1", request_key: "k1" });
    expect(waiting.state).toBe("waiting");
    expect(pendingWaits(waiting)).toHaveLength(1);
    const settled = resolveWait(waiting, "w1", "succeeded");
    expect(settled.state).toBe("open");
    expect(settled.waits[0]).toMatchObject({ state: "resolved", outcome: "succeeded" });
  });

  it("never mutates its input", () => {
    const record = base();
    const frozen = JSON.stringify(record);
    openWait(record, { id: "w1", target: runRef("E1", "R1") });
    spend(record, { executions: 1 });
    recordAttempt(record, { id: "a1", worker: "codex", task: "t", status: "completed", summary: "s", files_changed: [] });
    expect(JSON.stringify(record)).toBe(frozen);
  });

  it("refuses duplicate wait and attempt ids", () => {
    const once = openWait(base(), { id: "w1", target: runRef("E1", "R1") });
    expect(() => openWait(once, { id: "w1", target: runRef("E1", "R2") })).toThrow(/already exists/);
  });

  it("tracks spend against the budget and refuses overspending", () => {
    const spent = spend(base(), { executions: 2, worker_usd: 0.25 });
    expect(budgetLeft(spent)).toEqual({ worker_usd: 0.75, executions: 0 });
    expect(() => requireBudget(spent, { executions: 1 })).toThrow(/budget exhausted: executions/);
    expect(() => requireBudget(spent, { worker_runs: 99 })).not.toThrow();
  });

  it("closed delegations stay closed; paused ones take no step", () => {
    const done = transition(base(), "done");
    expect(() => transition(done, "open")).toThrow(/done/);
    expect(() => requireActive(transition(base(), "paused"))).toThrow(/paused/);
  });

  it("renders a status digest with the five supervision facts", () => {
    const record = openWait(spend(base(), { executions: 1 }), { id: "w1", target: runRef("E1", "R1"), on_resolve: "assess" });
    const text = renderStatus("Sequence study", record, { next: "assess the run", evidence: ["knowledges/report.md"] });
    for (const needle of ["## Status", "Goal", "Waiting on", "Evidence", "Capabilities", "Next", "executions: spent 1 of 2"]) expect(text).toContain(needle);
  });
});

describe("policy", () => {
  it("refuses a tool whose action was not granted", () => {
    expect(() => requireAction(base(), "molab_create_experiment")).toThrow(PolicyError);
    expect(() => requireAction(base(), "molab_start_execution")).not.toThrow();
  });

  it("a child holds no action its parent lacks", () => {
    expect(() => requireSubset(["read"], ["read", "start_execution"])).toThrow(/start_execution/);
    expect(() => requireSubset(["read", "start_execution"], ["read"])).not.toThrow();
  });

  it("nests experiment and run scopes by ref", () => {
    expect(withinScope("molab:experiment/E1", runRef("E1", "R1"))).toBe(true);
    expect(withinScope("molab:experiment/E1", runRef("E2", "R1"))).toBe(false);
    expect(withinScope("molab:project/P1", runRef("E1", "R1"), "P1")).toBe(true);
    expect(withinScope("molab:project/P1", runRef("E1", "R1"), "P2")).toBe(false);
    expect(withinScope("molab:project/P1", runRef("E1", "R1"))).toBe(true);
  });
});

describe("refs and config", () => {
  it("parses molab refs and names their source kind", () => {
    expect(parseRef(executionRef("E1", "R1", "e02"))).toEqual({ experiment: "E1", run: "R1", execution: "e02" });
    expect(sourceKindOf("molab:project/P1")).toBe("project");
    expect(sourceKindOf(runRef("E1", "R1"))).toBe("run");
    expect(() => parseRef("projects/p1")).toThrow(/not a molab/);
  });

  it("defaults config and rejects unknown keys", () => {
    const config = parseConfig({});
    expect(config.molab.url).toBe("http://localhost:8000");
    expect(config.pollSeconds).toBe(30);
    expect(() => parseConfig({ molab: { url: "not a url" } })).toThrow(/invalid config/);
    expect(() => parseConfig({ surprise: true })).toThrow(/invalid config/);
  });
});

describe("tool registration", () => {
  it("every research tool compiles under DSH's tool schema rules", async () => {
    const { researchTools } = await import("../../packages/research/src/index.js");
    const { toDshTool } = await import("../../packages/research/src/dsh/adapter.js");
    const specs = researchTools({ config: parseConfig({}) } as never);
    const names = specs.map((spec) => {
      const tool = toDshTool(spec) as { name: string };
      return tool.name;
    });
    expect(names).toEqual([
      "research_context",
      "research_replay",
      "research_audit",
      "research_open",
      "research_plan",
      "research_dispatch",
      "molab_dry_run",
      "molab_create_experiment",
      "molab_create_run",
      "molab_start_execution",
      "research_wait",
      "research_status",
      "molab_read_outputs",
      "research_assess",
      "research_report",
      "research_decide",
      "research_resume",
      "research_retract",
      "research_pause",
      "molab_cancel_execution",
    ]);
  });
});

describe("tool values", () => {
  it("drop fields that would not survive JSON before they reach DSH", async () => {
    const { losslessValue } = await import("../../packages/research/src/dsh/adapter.js");
    const value = losslessValue({ text: "ok", meta: { observation: { relPath: "a.md" }, finding: undefined } });
    expect(value).toEqual({ text: "ok", meta: { observation: { relPath: "a.md" } } });
    expect(Object.keys(value.meta as object)).toEqual(["observation"]);
  });
});

describe("research_context refs", () => {
  it("puts the molab: ref the tools take on every project, experiment and run", async () => {
    const { withRefs } = await import("../../packages/research/src/tools/molab-tools.js");
    const view = withRefs({
      projects: [{ id: "p1", name: "pbix" }],
      experiments: [{ id: "e1", name: "chain", projectId: "p1" }],
      recentRuns: [{ runId: "r1", experimentId: "e1", projectId: "p1", status: "done" }],
      artifacts: [],
    }) as Record<string, { ref?: string }[]>;
    expect(view.projects![0]!.ref).toBe("molab:project/p1");
    expect(view.experiments![0]!.ref).toBe("molab:experiment/e1");
    expect(view.recentRuns![0]!.ref).toBe("molab:experiment/e1/run/r1");
    expect(view.artifacts).toEqual([]);
  });
});

describe("resume brief", () => {
  it("reports what each budget line has spent and every recent worker attempt", async () => {
    const { resumeBrief } = await import("../../packages/research/src/reconcile.js");
    const withWorker = DelegationRecord.parse({ ...toWire(base()), budget: { worker_runs: 2 } });
    const charged = recordAttempt(spend(withWorker, { worker_runs: 1 }), {
      id: "child-1",
      worker: "subagent_claude_code",
      task: "write hello.txt",
      status: "completed",
      summary: "wrote hello.txt",
      files_changed: [],
      started_at: "2026-11-04T15:00:00Z",
      ended_at: "2026-11-04T15:01:00Z",
    });
    const brief = resumeBrief("knowledges/d.md", { record: charged, observations: [], changed: false });
    expect(brief).toContain("worker_runs: spent 1, left 1");
    expect(brief).toContain("Worker attempts (1):");
    expect(brief).toContain("child-1 (subagent_claude_code) completed, 2026-11-04T15:00:00Z → 2026-11-04T15:01:00Z: wrote hello.txt\n  report: not filed");
  });

  it("carries the acceptance, plan, last decision, answers and each attempt's report, and says to assess from the report", async () => {
    const { resumeBrief } = await import("../../packages/research/src/reconcile.js");
    const { renderStatus } = await import("../../packages/research/src/delegation/status.js");
    const record = recordAnswer(
      recordDecision(
        recordAttempt(DelegationRecord.parse({ ...toWire(base()), acceptance: ["trimer has 205 atoms"], current_plan: "knowledges/plan-v1.md" }), {
          id: "child-1",
          worker: "spawn",
          task: "build",
          status: "completed",
          summary: "built",
          files_changed: [],
          report: "knowledges/worker-report-2026-11-04-child-1.md",
        }),
        { at: "2026-11-04T10:00:00Z", name: "Rebuild the bridge", kind: "fix", reason: "bridge wrong", evidence: [], next: "rebuild", questions: [] },
      ),
      { path: "knowledges/d.md", by: "roykid", text: "6 with 5" },
    );
    const brief = resumeBrief("knowledges/d.md", { record, observations: [], changed: false });
    expect(brief).toContain("Acceptance:\n- trimer has 205 atoms");
    expect(brief).toContain("Plan: knowledges/plan-v1.md");
    expect(brief).toContain("Last decision: fix: Rebuild the bridge — next: rebuild");
    expect(brief).toContain("- roykid (knowledges/d.md): 6 with 5");
    expect(brief).toContain("  report: knowledges/worker-report-2026-11-04-child-1.md");
    expect(brief).toContain("Next: assess each finished attempt from its report (research_assess report: <path>); read outputs (molab_read_outputs) only if the report is missing, invalid or contradicts the acceptance criteria.");
    const status = renderStatus("d", record);
    expect(status).toContain("**Last worker attempt:** child-1 (spawn): completed — built; report knowledges/worker-report-2026-11-04-child-1.md");
    expect(status).toContain("**Last decision:** fix: Rebuild the bridge — next: rebuild");
    expect(status).toContain("## Decisions\n\n- 2026-11-04T10:00:00Z **fix** Rebuild the bridge: bridge wrong — next: rebuild");
    expect(status).toContain("## Answers from people\n\n- roykid (knowledges/d.md): 6 with 5");
  });
});
