/**
 * The worker report: parsed from a structured value or the last json block,
 * filed as a Report linked to the attempt with every capability gap as an
 * Observation, a check on the attempt when it is missing or invalid, read by
 * research_assess(report) to prefill the verdicts, and filed once.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { assertObjectJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { lastJsonBlock, parseWorkerReport, verdictsFrom, WORKER_REPORT_SCHEMA, WorkerReport } from "../../packages/research/src/delegation/report.js";
import { linkWorkerReport, settledLinks } from "../../packages/research/src/delegation/reports.js";
import { researchHarness, type ResearchHarness, sampleReport } from "../research-harness.js";

let h: ResearchHarness;

const dispatch = (path: string, over: Record<string, unknown> = {}) =>
  h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Build the trimer", task: "Build the trimer.", expected: ["trimer has 205 atoms"], ...over });

const REPORT_PATH = "knowledges/worker-report-2026-11-04-child-1.md";

describe("parsing", () => {
  it("validates a structured value, filling the defaults molab omits", () => {
    const parsed = parseWorkerReport({ outcome: "blocked", summary: "No unit structure.", extra: "ignored" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report).toEqual({ outcome: "blocked", summary: "No unit structure.", checks: {}, products: [], files_changed: [], protocol_deviations: [], capability_gaps: [], open_questions: [], tokens: "unavailable" });
  });

  it("takes the last fenced json block of a text", () => {
    const text = "First try:\n```json\n{\"outcome\": \"failed\", \"summary\": \"old\"}\n```\nThen:\n```json\n{\"outcome\": \"done\", \"summary\": \"new\", \"tokens\": {\"input\": 10, \"output\": 2}}\n```\n";
    expect(lastJsonBlock(text)).toContain("\"new\"");
    const parsed = parseWorkerReport(text);
    expect(parsed.ok && parsed.report.summary).toBe("new");
    expect(parsed.ok && parsed.report.tokens).toEqual({ input: 10, output: 2 });
  });

  it("names the problems of a missing, broken or wrong report", () => {
    expect(parseWorkerReport("")).toEqual({ ok: false, problems: ["the worker produced no output"] });
    expect(parseWorkerReport("I built it.")).toMatchObject({ ok: false, problems: [expect.stringContaining("fenced ```json block")] });
    expect(parseWorkerReport("```json\n{oops\n```")).toMatchObject({ ok: false, problems: [expect.stringContaining("not valid JSON")] });
    expect(parseWorkerReport({ outcome: "great", summary: "" })).toMatchObject({ ok: false, problems: [expect.stringContaining("outcome"), expect.stringContaining("summary")] });
    expect(parseWorkerReport([1])).toMatchObject({ ok: false, problems: ["the report is not a JSON object"] });
  });

  it("prefills execution from the outcome and data from the checks", () => {
    const done = verdictsFrom(WorkerReport.parse(sampleReport()));
    expect(done.execution.verdict).toBe("pass");
    expect(done.data).toMatchObject({ verdict: "pass", reason: expect.stringContaining("trimer has 205 atoms: pass (205)") });
    const failed = verdictsFrom(WorkerReport.parse(sampleReport({ outcome: "failed", checks: { a: { verdict: "pass" }, b: { verdict: "fail", note: "673 atoms" } }, protocol_deviations: [{ item: "seed", expected: "42", actual: "7" }] })));
    expect(failed.execution.verdict).toBe("fail");
    expect(failed.data).toMatchObject({ verdict: "fail", reason: expect.stringMatching(/failed checks: b: fail — 673 atoms; 1 protocol deviation\(s\): seed/) });
    const partial = verdictsFrom(WorkerReport.parse(sampleReport({ outcome: "partial", checks: {} })));
    expect(partial.execution.verdict).toBe("unknown");
    expect(partial.data).toMatchObject({ verdict: "unknown", reason: "the report lists no checks" });
    expect(verdictsFrom(WorkerReport.parse(sampleReport({ checks: { a: { verdict: "unknown" } } }))).data.verdict).toBe("unknown");
  });

  it("keeps the JSON Schema twin inside DSH's subset, and it accepts what the zod schema accepts", () => {
    expect(() => assertObjectJsonSchema(WORKER_REPORT_SCHEMA)).not.toThrow();
    expect(validateJsonSchemaValue(WORKER_REPORT_SCHEMA as never, sampleReport())).toEqual([]);
    expect(validateJsonSchemaValue(WORKER_REPORT_SCHEMA as never, sampleReport({ tokens: { input: 1, output: 2 } }))).toEqual([]);
    expect(validateJsonSchemaValue(WORKER_REPORT_SCHEMA as never, { outcome: "maybe", summary: "s" })).not.toEqual([]);
  });
});

describe("filing", () => {
  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("files a structured report as a Report linked to the attempt, with each capability gap as an Observation", async () => {
    const path = await h.open();
    h.molab.plantFile("experiments/chain/scratch/trimer.pdb");
    await dispatch(path);
    const brief = (await h.record(path)).attempts[0]!.brief!;
    h.workers.starts[0]!.settle({
      output: "done",
      structured: sampleReport({
        capability_gaps: [{ component: "molpy", title: "bridge() ignores port order", repro: "molpy.bridge(a, b, ports=(6, 5))", version: "molpy 0.4.1", fix: "respect ports" }],
        tokens: { input: 1200, output: 300 },
      }),
    });
    await settledLinks(h.deps, path);

    const attempt = (await h.record(path)).attempts[0]!;
    expect(attempt).toMatchObject({ status: "completed", summary: "Built the trimer and the 10-mer; both connect as e20 did.", ended_at: "2026-11-04T09:00:00.000Z", report: REPORT_PATH, tokens: { input: 1200, output: 300 }, files_changed: ["experiments/chain/scratch/build.py"] });
    expect(attempt.check ?? undefined).toBeUndefined();

    const doc = h.molab.docs.get(REPORT_PATH)!;
    expect(doc.cls).toBe("Report");
    expect(doc.createdBy).toBe("spawn");
    expect(doc.record).toMatchObject({ kind: "worker_report", delegation: path, attempt: "child-1", brief, brief_digest: attempt.brief_digest, outcome: "done", checks: { "trimer has 205 atoms": { verdict: "pass", value: 205 } } });
    expect(doc.sources).toEqual([{ kind: "file", ref: "experiments/chain/scratch/trimer.pdb" }]);
    expect(doc.edges).toEqual([
      { target: brief, role: "derived_from" },
      { target: path, role: "derived_from" },
    ]);
    expect(doc.body).toContain("| trimer has 205 atoms | pass | 205 |");
    expect(doc.body).toContain("molpy: bridge() ignores port order (molpy 0.4.1)");

    // A science gap is an item of the workspace's one capability-gaps Todo, not a document of its own.
    expect([...h.molab.docs.values()].filter((item) => item.cls === "Observation")).toEqual([]);
    const gaps = h.molab.docs.get("knowledges/capability-gaps.md")!;
    expect(gaps.cls).toBe("Todo");
    expect(gaps.record).toEqual({
      items: [{ id: "molpy-bridge-ignores-port-order", title: "molpy: bridge() ignores port order", status: "open" }],
      gaps: [{ id: "molpy-bridge-ignores-port-order", component: "molpy", title: "bridge() ignores port order", repro: "molpy.bridge(a, b, ports=(6, 5))", version: "molpy 0.4.1", fix: "respect ports", seen_in: [REPORT_PATH] }],
    });
    expect(gaps.body).toContain("- Reproduce: molpy.bridge(a, b, ports=(6, 5))");
    expect(h.warnings).toEqual([]);
  });

  it("files a Claude Code report from the last json block, and does not let a product molab cannot find block it", async () => {
    const path = await h.open();
    await dispatch(path, { worker: "claude-code" });
    h.workers.starts[0]!.settle({ output: `All done.\n\n\`\`\`json\n${JSON.stringify(sampleReport())}\n\`\`\`` });
    await settledLinks(h.deps, path);
    const doc = h.molab.docs.get(REPORT_PATH)!;
    expect(doc.createdBy).toBe("claude-code");
    expect(doc.sources).toEqual([{ kind: "project", ref: "molab:project/P1" }]);
    expect(doc.body).toContain("Molab could not verify the products as workspace files");
    expect((await h.record(path)).attempts[0]!.report).toBe(REPORT_PATH);
  });

  it("leaves a check on the attempt when the report is missing or invalid, and the supervisor sees it", async () => {
    const path = await h.open({ budget: { worker_runs: 3 } });
    await dispatch(path, { worker: "claude-code" });
    h.workers.starts[0]!.settle({ output: "I built the trimer and it looks fine." });
    await dispatch(path, { worker: "claude-code", task: "Second." });
    h.workers.starts[1]!.settle({ output: "", stopReason: "error", diagnostic: "process exited 1" });
    await dispatch(path, { task: "Third." });
    h.workers.starts[2]!.settle({ output: "x", structured: { outcome: "great", summary: "" } });
    await settledLinks(h.deps, path);
    const [first, second, third] = (await h.record(path)).attempts;
    expect(first).toMatchObject({ status: "completed", check: expect.stringMatching(/^invalid: the output does not end with a fenced ```json block/), summary: "I built the trimer and it looks fine." });
    expect(first!.report ?? undefined).toBeUndefined();
    expect(second).toMatchObject({ status: "error", check: expect.stringMatching(/^unreported: the worker produced no output \(the worker ended with error: process exited 1\)/) });
    expect(third!.check).toMatch(/^invalid: outcome: /);
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Report")).toHaveLength(0);

    const status = await h.call("research_status", { delegation: path });
    expect(status.text).toContain("report: invalid: the output does not end with a fenced ```json block");
    expect(status.text).toContain("research_assess report: <path>");
    expect(h.warnings).toEqual([]);
  });

  it("research_assess(report) prefills execution and data from the report, cites it, and links it", async () => {
    const path = await h.open();
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport({ checks: { "trimer has 205 atoms": { verdict: "fail", value: 204, note: "one H short" } } }) });
    await settledLinks(h.deps, path);
    const assessed = await h.call("research_assess", {
      delegation: path,
      name: "Trimer round 1",
      report: REPORT_PATH,
      analysis: { verdict: "pass", reason: "atom count is the right check" },
      conclusion: { verdict: "fail", reason: "one atom short" },
      evidence: [],
    });
    expect(assessed.text).toContain("failed at data, conclusion");
    const meta = assessed.meta as { report: { relPath: string }; assessment: Record<string, { verdict: string; reason: string }>; attempt: string };
    expect(meta.attempt).toBe("child-1");
    expect(meta.assessment.execution).toMatchObject({ verdict: "pass", reason: expect.stringContaining("the worker reports done") });
    expect(meta.assessment.data).toMatchObject({ verdict: "fail", reason: expect.stringContaining("trimer has 205 atoms: fail (204) — one H short") });
    const doc = h.molab.docs.get(meta.report.relPath)!;
    expect(doc.record).toMatchObject({ delegation: path, attempt: "child-1", report: REPORT_PATH, assessment: { data: { verdict: "fail" } } });
    expect(doc.edges).toContainEqual({ target: REPORT_PATH, role: "derived_from" });
    expect(doc.body).toContain("Assessed: attempt child-1 (" + REPORT_PATH + ")");
    expect(doc.body).toContain("## Products (from the report)");
    // An explicit verdict wins over the prefilled one.
    const again = await h.call("research_assess", { delegation: path, name: "Trimer round 1 (override)", report: REPORT_PATH, execution: { verdict: "fail", reason: "it crashed" }, analysis: { verdict: "pass", reason: "a" }, conclusion: { verdict: "unknown", reason: "c" }, evidence: [] });
    expect((again.meta as { assessment: { execution: { verdict: string } } }).assessment.execution.verdict).toBe("fail");
  });

  it("research_assess refuses a report that is not a worker report, and needs a target otherwise", async () => {
    const path = await h.open();
    h.molab.plantDoc("knowledges/not-a-report.md", { cls: "Report", record: { delegation: path, summary: "x" } });
    const levels = { analysis: { verdict: "pass", reason: "a" }, conclusion: { verdict: "pass", reason: "c" }, evidence: [] };
    await expect(h.call("research_assess", { delegation: path, name: "n", report: "knowledges/not-a-report.md", ...levels })).rejects.toThrow(/not a worker report: .*kind: /);
    await expect(h.call("research_assess", { delegation: path, name: "n", ...levels })).rejects.toThrow(/assess a run \(target and project\) or a worker attempt \(report\)/);
    const { experiment, run } = h.molab.seedRun();
    await expect(h.call("research_assess", { delegation: path, name: "n", target: `molab:experiment/${experiment}/run/${run}`, project: "P1", ...levels })).rejects.toThrow(/execution and data verdicts/);
  });

  it("research_assess(report) links a report filed by hand to its attempt, once", async () => {
    const path = await h.open();
    await dispatch(path);
    const attempt = (await h.record(path)).attempts[0]!;
    h.molab.plantDoc("knowledges/by-hand.md", { cls: "Report", record: { kind: "worker_report", delegation: path, attempt: "child-1", brief: attempt.brief, brief_digest: attempt.brief_digest, ...sampleReport({ checks: undefined, products: undefined }) } });
    const levels = { analysis: { verdict: "pass", reason: "a" }, conclusion: { verdict: "pass", reason: "c" }, evidence: [] };
    await h.call("research_assess", { delegation: path, name: "By hand", report: "knowledges/by-hand.md", ...levels });
    expect((await h.record(path)).attempts[0]).toMatchObject({ report: "knowledges/by-hand.md", status: "completed", ended_at: "2026-11-04T09:00:00.000Z" });
    // The result arriving later does not file a second report.
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settledLinks(h.deps, path);
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Report" && doc.record.kind === "worker_report")).toHaveLength(1);
    h.molab.plantDoc("knowledges/other.md", { cls: "Report", record: { kind: "worker_report", delegation: path, attempt: "child-1", brief: attempt.brief, brief_digest: attempt.brief_digest, ...sampleReport() } });
    await expect(h.call("research_assess", { delegation: path, name: "Other", report: "knowledges/other.md", ...levels })).rejects.toThrow(/already linked to knowledges\/by-hand.md/);
  });

  it("files once: a second filing of the same attempt returns the first", async () => {
    const path = await h.open();
    await dispatch(path);
    const outcome = { output: "", structured: sampleReport(), stopReason: "completed" };
    const first = await linkWorkerReport(h.deps, path, "child-1", outcome);
    const second = await linkWorkerReport(h.deps, path, "child-1", { ...outcome, structured: sampleReport({ summary: "different" }) });
    expect(first).toMatchObject({ linked: true, report: REPORT_PATH, reused: false });
    expect(second).toMatchObject({ linked: true, report: REPORT_PATH, reused: true, parsed: { summary: "Built the trimer and the 10-mer; both connect as e20 did." } });
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Report")).toHaveLength(1);
    await expect(linkWorkerReport(h.deps, path, "nope", outcome)).rejects.toThrow(/no attempt nope/);
  });

  it("merges the same science gap from two reports into one item that names both", async () => {
    const path = await h.open();
    const gap = { component: "molpy", title: "bridge() ignores port order", repro: "molpy.bridge(a, b, ports=(6, 5))" };
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport({ capability_gaps: [gap] }) });
    await settledLinks(h.deps, path);
    await h.end("child-1");
    await dispatch(path, { description: "round 2" });
    h.workers.starts[1]!.settle({ output: "", structured: sampleReport({ capability_gaps: [{ ...gap, version: "molpy 0.5" }] }) });
    await settledLinks(h.deps, path);
    const record = h.molab.docs.get("knowledges/capability-gaps.md")!.record as { items: unknown[]; gaps: { version?: string; seen_in: string[] }[] };
    expect(record.items).toHaveLength(1);
    expect(record.gaps).toHaveLength(1);
    expect(record.gaps[0]!.version).toBe("molpy 0.5");
    expect(record.gaps[0]!.seen_in).toHaveLength(2);
  });

  it("does not accept a report while the workspace has new validation errors, and tells the worker what to fix", async () => {
    const path = await h.open();
    await dispatch(path);
    h.molab.violations = [{ path: "experiments/chain/assets/networkdata-2", rule: "asset.ambiguous_title", detail: "differs from networkdata only by a number", severity: "error", hint: "" }];
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settledLinks(h.deps, path);
    const attempt = (await h.record(path)).attempts[0]!;
    expect(attempt.report).toBeUndefined();
    expect(attempt.check).toBe("workspace invalid (molab validate --new-only): asset.ambiguous_title experiments/chain/assets/networkdata-2: differs from networkdata only by a number");
    expect([...h.molab.docs.values()].filter((doc) => doc.cls === "Report")).toEqual([]);
    // The worker hears the errors, not the plain re-request.
    await h.end("child-1");
    const told = h.workers.continues.at(-1)!;
    expect(told.text).toContain("Your turn was not accepted: workspace invalid");
    expect(told.text).toContain("asset.ambiguous_title experiments/chain/assets/networkdata-2");
    expect(told.text).toContain("molab validate --new-only");
    // Fixed: the next report is accepted.
    h.molab.violations = [];
    await h.end("child-1", "completed", `\`\`\`json\n${JSON.stringify(sampleReport())}\n\`\`\``);
    expect((await h.record(path)).attempts[0]!.report).toBe(REPORT_PATH);
  });

  it("a warning does not refuse a report; validation that cannot run does", async () => {
    const path = await h.open();
    await dispatch(path);
    h.molab.violations = [{ path: "experiments/chain", rule: "workflow.size", detail: "workflow.py has 900 lines", severity: "warning", hint: "" }];
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settledLinks(h.deps, path);
    expect((await h.record(path)).attempts[0]!.report).toBe(REPORT_PATH);

    const second = await h.open({ name: "Other study" });
    h.deps.validate = async () => {
      throw new Error("molab: command not found");
    };
    await dispatch(second, { description: "other" });
    h.workers.starts[1]!.settle({ output: "", structured: sampleReport() });
    await settledLinks(h.deps, second);
    expect((await h.record(second)).attempts[0]!.check).toBe("workspace invalid (molab validate --new-only): validate.unavailable (workspace): molab: command not found");
  });

  it("refuses to conclude or stop while an attempt has not ended, and records the last decision", async () => {
    const path = await h.open();
    await dispatch(path);
    const conclude = { delegation: path, name: "Done", decision: "conclude", reason: "r", evidence: [path], finding: { name: "F", statement: "s", scope: "c", host: "experiments/chain" } };
    await expect(h.call("research_decide", conclude)).rejects.toThrow(/cannot conclude while worker attempt child-1 has not ended/);
    await expect(h.call("research_decide", { delegation: path, name: "Stop", decision: "stop", reason: "r", evidence: [path] })).rejects.toThrow(/cannot stop while worker attempt child-1/);
    await expect(h.call("research_decide", { delegation: path, name: "Gap", decision: "capability_gap", reason: "r", evidence: [path] })).rejects.toThrow(/names its component/);
    // A harness gap (molab, DSH, Tack) is reported back and logged, never written into the science workspace.
    const before = [...h.molab.docs.keys()];
    const gap = await h.call("research_decide", { delegation: path, name: "molab lacks --fresh", decision: "capability_gap", reason: "reruns reuse stale outputs", evidence: [path], gap: { component: "molab", repro: "molab run --rerun" }, next: "work around with a new run" });
    expect(gap.text).toContain("harness gap (molab): it is not written to the workspace");
    expect([...h.molab.docs.keys()]).toEqual(before);
    expect(h.warnings.some((warning) => warning.includes("harness capability gap (molab): molab lacks --fresh"))).toBe(true);
    expect((await h.record(path)).decisions.at(-1)).toMatchObject({ kind: "capability_gap", name: "molab lacks --fresh", next: "work around with a new run" });
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await settledLinks(h.deps, path);
    // Gate results: the person approves the assessment before the conclusion.
    const assessed = await h.call("research_assess", { delegation: path, name: "Trimer", report: (await h.record(path)).attempts[0]!.report!, analysis: { verdict: "pass", reason: "r" }, conclusion: { verdict: "pass", reason: "r" }, evidence: [] });
    await h.approve(path, "results", (assessed.meta as { report: { relPath: string } }).report.relPath);
    const decided = await h.call("research_decide", conclude);
    expect(decided.text).toContain("Delegation is done");
  });
});
