/**
 * research_dispatch: the brief is compiled from the delegation and kept as a
 * Note, the worker starts on the port with the brief as its prompt (and the
 * report schema when its provider captures one), the attempt carries the
 * brief and its digest, a retried dispatch does not write a second brief,
 * and a spawn/fork worker can be continued.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOf } from "../../packages/research/src/tools/dispatch-tools.js";
import { researchHarness, type ResearchHarness, sampleReport } from "../research-harness.js";

let h: ResearchHarness;
let root: string;

const dispatch = (path: string, over: Record<string, unknown> = {}, session = "S1") =>
  h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Build the trimer", task: "Build the trimer from the unit.", expected: ["trimer.pdb", "trimer has 205 atoms"], ...over }, session);

const briefDocs = () => [...h.molab.docs.entries()].filter(([, doc]) => doc.cls === "Note" && doc.record.kind === "brief");

describe("research_dispatch", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "tack-ws-"));
    h = await researchHarness(root);
  });
  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("compiles the brief into a Note, starts the worker with it, and records brief and digest on the attempt", async () => {
    const path = await h.open({ plan: false });
    const planPath = await h.plan(path, { name: "Chain plan", hypothesis: "chains assemble", comparison: "vs e20", fixed: ["seed"], varied: ["length"], runs: "one", judgement: "atom counts", products: ["trimer.pdb"] });
    const value = await dispatch(path, { protocol: { reproduce: "molab:experiment/E1/run/R1/execution/e20", seed: 42 } });

    expect(briefDocs()).toHaveLength(1);
    const [notePath, note] = briefDocs()[0]!;
    expect(notePath).toBe("knowledges/brief-2026-11-04-sequence-study-round-1-build-the-trimer.md");
    expect(note.sources).toEqual([]);
    expect(note.createdBy).toBe("tack");
    const digest = createHash("sha256").update(note.body).digest("hex");
    expect(note.record).toEqual({ kind: "brief", delegation: path, round: 1, digest, inputs: [planPath], protocol: { reproduce: "molab:experiment/E1/run/R1/execution/e20", seed: 42 } });
    expect(note.body).toContain("# Brief: round 1 of " + path);
    expect(note.body).toContain("chains assemble");
    expect(note.body).toContain("## Mode: draft (nothing executes this round)");

    expect(h.workers.starts).toHaveLength(1);
    const start = h.workers.starts[0]!;
    expect(start.request).toMatchObject({ provider: "spawn", label: "Build the trimer", cwd: root, prompt: note.body, parentSessionId: "S1" });
    expect(start.request.outputSchema).toMatchObject({ type: "object", required: ["outcome", "summary"] });

    const record = await h.record(path);
    expect(record.attempts).toEqual([expect.objectContaining({ id: "child-1", worker: "spawn", status: "running", brief: notePath, brief_digest: digest })]);
    expect(record.spent.worker_runs).toBe(1);
    expect(value.text).toContain("Started attempt child-1 (spawn, round 1, mode draft)");
    expect(value.text).toContain("End your turn now");
    expect(value.text).toContain("research_assess(report: <path>)");
    expect(value.meta).toMatchObject({ attempt: "child-1", brief: notePath, digest, structured: true, mode: "draft" });
  });

  it("asks a provider without structured output for the json block instead of a schema", async () => {
    const path = await h.open();
    await dispatch(path, { worker: "claude-code" });
    const start = h.workers.starts[0]!;
    expect(start.request.outputSchema).toBeUndefined();
    expect(start.request.prompt).toContain("End your reply with exactly one fenced ```json block");
    expect(start.request.prompt).toContain("molab run --rerun --fresh");
    expect((await h.record(path)).attempts[0]!.worker).toBe("claude-code");
  });

  it("refuses an unknown worker, an empty task and no expected products", async () => {
    const path = await h.open();
    await expect(dispatch(path, { worker: "gemini" })).rejects.toThrow(/no worker provider "gemini"; registered: spawn, fork, claude-code, codex/);
    await expect(dispatch(path, { task: " " })).rejects.toThrow(/task/);
    await expect(dispatch(path, { expected: [] })).rejects.toThrow(/expected product/);
    expect(briefDocs()).toHaveLength(0);
    expect((await h.record(path)).spent.worker_runs).toBe(0);
  });

  it("does not write a second brief when a failed start is retried with the same task", async () => {
    const path = await h.open();
    h.workers.failNextStart("provider busy");
    await expect(dispatch(path)).rejects.toThrow(/provider busy/);
    expect(briefDocs()).toHaveLength(1);
    await dispatch(path);
    expect(briefDocs()).toHaveLength(1);
    const record = await h.record(path);
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]!.brief).toBe(briefDocs()[0]![0]);
    // The next round is a new brief.
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await new Promise((done) => setTimeout(done, 50));
    await dispatch(path, { task: "Build the decamer." });
    expect(briefDocs()).toHaveLength(2);
  });

  it("puts what people answered, the last decision and earlier reports into the next brief", async () => {
    const path = await h.open({ budget: { worker_runs: 3 } });
    await h.call("research_decide", { delegation: path, name: "Pairing?", decision: "ask_human", reason: "unclear", evidence: [path], questions: ["Mirror pairing: 6 with 5?"] });
    await h.call("research_resume", { delegation: path, answers: "Yes: pair 6 with 5, always.", by: "roykid" });
    await dispatch(path);
    h.workers.starts[0]!.settle({
      output: "",
      structured: sampleReport({
        outcome: "partial",
        capability_gaps: [{ component: "molpy", title: "bridge() ignores port order", repro: "molpy.bridge(a, b, ports=(6, 5))" }],
        open_questions: ["Is the bridge chiral?"],
      }),
    });
    await new Promise((done) => setTimeout(done, 50));
    await h.call("research_decide", { delegation: path, name: "Rebuild", decision: "fix", reason: "port order", evidence: [path], next: "rebuild with 6-5" });
    await dispatch(path, { task: "Build the decamer." });
    const prompt = h.workers.starts[1]!.request.prompt;
    expect(prompt).toContain(`roykid (${path}): Yes: pair 6 with 5, always.`);
    expect(prompt).toContain("- fix: Rebuild — port order; next: rebuild with 6-5");
    expect(prompt).toContain("- child-1 (spawn) completed");
    expect(prompt).toContain("outcome: partial — Built the trimer and the 10-mer");
    expect(prompt).toContain("trimer has 205 atoms: pass (205)");
    expect(prompt).toContain("report: knowledges/worker-report-2026-11-04-child-1.md");
    expect(prompt).toContain("Is the bridge chiral?");
    expect(prompt).toContain("molpy: bridge() ignores port order");
    expect(prompt).toContain("Current workflow: experiments/chain/workflow.py");
    const note = briefDocs()[1]![1];
    expect(note.record.inputs).toEqual(["knowledges/sequence-study-plan.md", "knowledges/worker-report-2026-11-04-child-1.md"]);
    expect(note.record.round).toBe(2);
  });

  it("writes attachments into the brief verbatim, and keeps them inside the served workspace", async () => {
    mkdirSync(join(root, "experiments/chain/scratch"), { recursive: true });
    writeFileSync(join(root, "experiments/chain/scratch/unit.smi"), "C1=CC=CC=C1 unit\n");
    const path = await h.open();
    await dispatch(path, { attachments: ["experiments/chain/scratch/unit.smi"] });
    const prompt = h.workers.starts[0]!.request.prompt;
    expect(prompt).toContain("### experiments/chain/scratch/unit.smi");
    expect(prompt).toContain("C1=CC=CC=C1 unit");
    await expect(dispatch(path, { task: "x", attachments: ["../outside.txt"] })).rejects.toThrow(/outside the served workspace/);
    await expect(dispatch(path, { task: "y", attachments: ["experiments/missing.txt"] })).rejects.toThrow(/cannot read attachment experiments\/missing.txt/);
  });

  it("continues a spawn worker with the next brief as a new attempt round, and refuses to continue a CLI one", async () => {
    const path = await h.open({ budget: { worker_runs: 3 } });
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await new Promise((done) => setTimeout(done, 50));
    const value = await dispatch(path, { task: "Now the decamer.", continue: "child-1" });
    expect(h.workers.starts).toHaveLength(1);
    expect(h.workers.continues).toEqual([{ childId: "child-1", text: expect.stringContaining("Now the decamer."), parentSessionId: "S1" }]);
    expect(h.workers.continues[0]!.text).toContain("(continues attempt child-1)");
    expect(h.workers.continues[0]!.text).toContain("End your reply with exactly one fenced ```json block");
    const record = await h.record(path);
    expect(record.attempts.map((attempt) => attempt.id)).toEqual(["child-1", "child-1:r2"]);
    expect(record.attempts[1]).toMatchObject({ worker: "spawn", status: "running", brief: expect.stringMatching(/round-2/) });
    expect(record.spent.worker_runs).toBe(2);
    expect(value.text).toContain("Continued worker child-1 as attempt child-1:r2");
    expect(childOf("child-1:r2")).toBe("child-1");

    // Its end files the report from its final text.
    await h.end("child-1", "completed", `Done.\n\n\`\`\`json\n${JSON.stringify(sampleReport({ summary: "Decamer built." }))}\n\`\`\``);
    const after = await h.record(path);
    expect(after.attempts[1]).toMatchObject({ status: "completed", summary: "Decamer built.", report: "knowledges/worker-report-2026-11-04-child-1-r2.md" });

    const second = await h.open({ budget: { worker_runs: 2 }, name: "Order study" });
    await dispatch(second, { worker: "claude-code" });
    await expect(dispatch(second, { continue: "child-2" })).rejects.toThrow(/ran on claude-code, which takes no further messages/);
    await expect(dispatch(second, { continue: "nope" })).rejects.toThrow(/no attempt nope/);
  });
});
