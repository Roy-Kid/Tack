/**
 * The brief a worker is dispatched with: every section the supervisor owes
 * the worker, rendered from the delegation record; a stable digest; the
 * rules that differ between an in-process worker and a CLI one.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import { type BriefInput, compileBrief, knownGaps, PROBE_CAP } from "../../packages/research/src/brief.js";
import { DelegationRecord, recordAnswer, recordAttempt, recordDecision } from "../../packages/research/src/delegation/model.js";
import { WorkerReport } from "../../packages/research/src/delegation/report.js";
import { sampleReport } from "../research-harness.js";

const DIGEST = "a".repeat(64);

function record(): DelegationRecord {
  const base = DelegationRecord.parse({
    goal: "Assemble PBIX-Br chains",
    scope: "molab:project/P1",
    actions: ["read", "delegate_worker", "write_knowledge"],
    budget: { worker_runs: 4, executions: 10 },
    spent: { worker_runs: 1, executions: 0, worker_usd: 0, wall_hours: 0 },
    acceptance: ["trimer has 205 atoms", "decamer has 674 atoms"],
    stop_conditions: ["budget exhausted"],
    current_plan: "knowledges/chain-plan.md",
  });
  const answered = recordAnswer(base, { path: "knowledges/chain-study.md", by: "roykid", text: "Mirror pairing: pair 6 with 5, always." });
  const decided = recordDecision(answered, {
    at: "2026-11-04T07:00:00Z",
    name: "Rebuild the bridge",
    kind: "fix",
    reason: "the 6-6 pairing gave the wrong ring",
    evidence: [],
    next: "rebuild the bridge with the 6-5 pairing",
    questions: [],
  });
  return recordAttempt(decided, {
    id: "child-1",
    worker: "spawn",
    task: "Build the trimer",
    status: "completed",
    summary: "built it",
    files_changed: [],
    started_at: "2026-11-04T08:00:00Z",
    ended_at: "2026-11-04T08:20:00Z",
    brief: "knowledges/brief-2026-11-04-round-1.md",
    brief_digest: DIGEST,
    report: "knowledges/worker-report-2026-11-04-child-1.md",
  });
}

function input(over: Partial<BriefInput> = {}): BriefInput {
  const current = record();
  const report = WorkerReport.parse(
    sampleReport({
      outcome: "partial",
      protocol_deviations: [{ item: "seed", expected: "42", actual: "7" }],
      capability_gaps: [{ component: "molpy", title: "bridge() ignores port order", repro: "molpy.bridge(a, b, ports=(6, 5))", version: "molpy 0.4.1" }],
      open_questions: ["Is the C(CF3) bridge chiral?"],
      next: "build the decamer",
    }),
  );
  return {
    delegation: "knowledges/chain-study.md",
    record: current,
    round: 2,
    worker: "spawn",
    inProcess: true,
    structured: true,
    cwd: "/lab/pbix",
    task: "Build the 10-mer from the trimer.",
    expected: ["decamer.pdb", "decamer has 674 atoms"],
    protocol: { reproduce: "molab:experiment/E1/run/R1/execution/e20", seed: 42, stereo: "racemic", charges: "neutral" },
    plan: { path: "knowledges/chain-plan.md", body: "# Chain plan\n\nHypothesis: chains assemble." },
    attempts: [{ attempt: current.attempts[0]!, report }],
    attachments: [{ path: "experiments/chain/scratch/unit.smi", text: "C1=CC=CC=C1" }],
    ...over,
  };
}

describe("compileBrief", () => {
  it("renders every section the worker needs, in order", () => {
    const brief = compileBrief(input());
    const headings = [...brief.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Goal, scope, acceptance, stop conditions, budget",
      "Task (this round)",
      "Mode: run",
      "Protocol",
      "Plan",
      "What people answered (verbatim; do not ask these again)",
      "Last decision",
      "Earlier attempts",
      "Workflow",
      "Known capability gaps (do not rediscover; work around or report)",
      "Attachments",
      "Workspace rules",
      "Report (required)",
    ]);
    expect(brief.body).toContain("- Goal: Assemble PBIX-Br chains");
    expect(brief.body).toContain("- trimer has 205 atoms");
    expect(brief.body).toContain("worker_runs: 3 left of 4");
    expect(brief.body).toContain("Build the 10-mer from the trimer.");
    expect(brief.body).toContain("- decamer has 674 atoms");
    expect(brief.body).toContain("Reproduce exactly: molab:experiment/E1/run/R1/execution/e20");
    expect(brief.body).toContain("- Seed: 42.");
    expect(brief.body).toContain("Hypothesis: chains assemble.");
    expect(brief.body).toContain("roykid (knowledges/chain-study.md): Mirror pairing: pair 6 with 5, always.");
    expect(brief.body).toContain("- fix: Rebuild the bridge — the 6-6 pairing gave the wrong ring; next: rebuild the bridge with the 6-5 pairing");
    expect(brief.body).toContain("child-1 (spawn) completed");
    expect(brief.body).toContain("outcome: partial — Built the trimer");
    expect(brief.body).toContain("trimer has 205 atoms: pass (205)");
    expect(brief.body).toContain("seed: expected 42, actual 7");
    expect(brief.body).toContain("Is the C(CF3) bridge chiral?");
    expect(brief.body).toContain("report: knowledges/worker-report-2026-11-04-child-1.md");
    expect(brief.body).toContain("Current workflow: experiments/chain/workflow.py. It is this experiment's one workflow");
    expect(brief.body).toContain("split what grows into modules under the experiment's lib/");
    expect(brief.body).toContain("molpy: bridge() ignores port order (molpy 0.4.1)");
    expect(brief.body).toContain("### experiments/chain/scratch/unit.smi");
    expect(brief.body).toContain("C1=CC=CC=C1");
    expect(brief.body).toContain("| outcome | done \\| partial \\| blocked \\| failed |");
    expect(brief.body).toContain("| capability_gaps |");
  });

  it("tells an in-process worker to use the molab_* tools and a CLI worker the molab command, and how to hand in the report", () => {
    const inProcess = compileBrief(input()).body;
    expect(inProcess).toContain("use the molab_* tools");
    expect(inProcess).toContain("Do not run the `molab` CLI from the shell");
    expect(inProcess).toContain("Submit it with the structured_output tool");
    expect(inProcess).toContain(`at most ${PROBE_CAP} exploratory commands`);
    expect(inProcess).toContain("Report, do not guess");
    expect(inProcess).toContain("scratch files go only under experiments/<experiment>/scratch/".replace("scratch files", "Scratch files"));
    expect(inProcess).toContain("Never hand-edit index.md, executions/ or .molab/");
    expect(inProcess).toContain("Register only final products as assets (structures, force fields, simulation inputs, figures). Logs and per-task evidence JSON stay in the task's out/ directory");
    expect(inProcess).toContain("modules under experiments/<experiment>/lib/");
    expect(inProcess).toContain("never scaffold experiments for roadmap stages that have not started");
    expect(inProcess).toContain("run `molab validate --new-only` and fix every error it lists");
    const cli = compileBrief(input({ worker: "claude-code", inProcess: false, structured: false })).body;
    expect(cli).toContain("molab run --rerun --fresh");
    expect(cli).toContain("Do not write knowledge documents (`molab knowledge write`)");
    expect(cli).toContain("End your reply with exactly one fenced ```json block");
    expect(cli).not.toContain("structured_output");
  });

  it("digests the body with sha256, the same for the same input", () => {
    const first = compileBrief(input());
    const second = compileBrief(input());
    expect(first.digest).toBe(createHash("sha256").update(first.body).digest("hex"));
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(compileBrief(input({ task: "Something else" })).digest).not.toBe(first.digest);
  });

  it("records what it was compiled from, with the protocol, as the Note's record", () => {
    const brief = compileBrief(input());
    expect(brief.record).toEqual({
      kind: "brief",
      delegation: "knowledges/chain-study.md",
      round: 2,
      digest: brief.digest,
      inputs: ["knowledges/chain-plan.md", "knowledges/worker-report-2026-11-04-child-1.md"],
      protocol: { reproduce: "molab:experiment/E1/run/R1/execution/e20", seed: 42, stereo: "racemic", charges: "neutral" },
    });
    expect(compileBrief(input({ protocol: {} })).record.protocol).toEqual({});
  });

  it("shows the last three attempts, says when there is nothing yet, and dedupes known gaps", () => {
    const current = record();
    const attempt = (id: string) => ({ attempt: { ...current.attempts[0]!, id }, report: WorkerReport.parse(sampleReport({ capability_gaps: [{ component: "molab", title: "no --fresh", repro: "molab run --rerun" }] })) });
    const many = compileBrief(input({ attempts: ["a", "b", "c", "d"].map(attempt) })).body;
    expect(many).toContain("## Earlier attempts (last 3 of 4)");
    expect(many).not.toContain("- a (spawn)");
    expect(many).toContain("- d (spawn)");
    expect(many.match(/molab: no --fresh/g)).toHaveLength(1);
    expect(knownGaps(["a", "b"].map(attempt))).toHaveLength(1);
    const first = compileBrief(input({ attempts: [], attachments: [], plan: undefined, record: DelegationRecord.parse({ goal: "g", scope: "molab:project/P1" }), protocol: {} })).body;
    expect(first).toContain("- none: this is the first round");
    expect(first).toContain("- No plan is recorded yet.");
    expect(first).toContain("- nothing yet");
    expect(first).toContain("No protocol was fixed for this round");
    expect(first).toContain("Budget left: unlimited.");
    expect(first).not.toContain("## Attachments");
  });

  it("names the attempt a round continues", () => {
    expect(compileBrief(input({ continues: "child-1" })).body).toContain("- Round: 2 (continues attempt child-1)");
  });
});
