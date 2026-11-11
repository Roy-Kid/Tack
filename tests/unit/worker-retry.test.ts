/**
 * A continuable worker (spawn, fork) that ends without a valid report is
 * asked for it once: the attempt is open again until the reply ends, the
 * reply's report is filed through the continue path, a second end without
 * one settles the attempt as unreported with no third request, a CLI worker
 * is not asked, and a clean end asks nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { RE_REQUEST_NOTE, REPORT_RE_REQUEST } from "../../packages/research/src/workers.js";
import { NOW, researchHarness, type ResearchHarness, sampleReport } from "../research-harness.js";

let h: ResearchHarness;

const dispatch = (path: string, over: Record<string, unknown> = {}) =>
  h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Build the trimer", task: "Build the trimer.", expected: ["trimer has 205 atoms"], ...over });

const jsonBlock = (report: Record<string, unknown>) => `Filed.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
const REPORT_PATH = "knowledges/worker-report-2026-11-04-child-1.md";

describe("report re-request", () => {
  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("asks a spawn worker that ended in error without a report for it once, reopens the attempt, and files the reply's report", async () => {
    const path = await h.open();
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", stopReason: "error", diagnostic: "MALFORMED_RESPONSE" });
    await h.end("child-1", "error");

    expect(h.workers.continues).toEqual([{ childId: "child-1", text: REPORT_RE_REQUEST, parentSessionId: "S1" }]);
    expect(REPORT_RE_REQUEST).toContain("exactly one fenced ```json block");
    expect(REPORT_RE_REQUEST).toContain("summary at most 400 characters");
    let attempt = (await h.record(path)).attempts[0]!;
    expect(attempt).toMatchObject({ status: "running", check: `unreported: the worker produced no output (the worker ended with error: MALFORMED_RESPONSE); ${RE_REQUEST_NOTE}` });
    expect(attempt.ended_at ?? undefined).toBeUndefined();
    expect(attempt.report ?? undefined).toBeUndefined();
    const status = await h.call("research_status", { delegation: path });
    expect(status.text).toContain(`child-1 (spawn) running`);
    expect(status.text).toContain(RE_REQUEST_NOTE);

    await h.end("child-1", "completed", jsonBlock(sampleReport({ summary: "Trimer built; 205 atoms." })));
    attempt = (await h.record(path)).attempts[0]!;
    expect(attempt).toMatchObject({ status: "completed", summary: "Trimer built; 205 atoms.", ended_at: NOW, report: REPORT_PATH });
    expect(attempt.check ?? undefined).toBeUndefined();
    expect(h.molab.docs.get(REPORT_PATH)?.createdBy).toBe("spawn");
    expect(h.workers.continues).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it("asks once: a second end without a report settles the attempt as unreported, and a third end is ignored", async () => {
    const path = await h.open();
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", stopReason: "error" });
    await h.end("child-1", "error");
    expect(h.workers.continues).toHaveLength(1);

    await h.end("child-1", "completed", "I built it, the files are in scratch.");
    const attempt = (await h.record(path)).attempts[0]!;
    expect(attempt).toMatchObject({ status: "completed", ended_at: NOW, check: `invalid: the output does not end with a fenced \`\`\`json block holding the report; ${RE_REQUEST_NOTE}` });
    expect(attempt.report ?? undefined).toBeUndefined();
    expect(h.workers.continues).toHaveLength(1);

    await h.end("child-1", "error");
    expect((await h.record(path)).attempts[0]!.status).toBe("completed");
    expect(h.workers.continues).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it("asks when a completed end carries a report that does not parse", async () => {
    const path = await h.open();
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "done", structured: { outcome: "great", summary: "" } });
    await h.end("child-1", "completed", "done");
    expect(h.workers.continues).toHaveLength(1);
    expect((await h.record(path)).attempts[0]).toMatchObject({ status: "running", check: expect.stringMatching(new RegExp(`^invalid: outcome: .*; ${RE_REQUEST_NOTE}$`)) });
  });

  it("asks a fork worker but not a CLI one, which takes no further messages", async () => {
    const path = await h.open({ budget: { worker_runs: 2 } });
    await dispatch(path, { worker: "claude-code" });
    h.workers.starts[0]!.settle({ output: "", stopReason: "error", diagnostic: "process exited 1" });
    await h.end("child-1", "error");
    expect(h.workers.continues).toEqual([]);
    expect((await h.record(path)).attempts[0]).toMatchObject({ status: "error", ended_at: NOW, check: "unreported: the worker produced no output (the worker ended with error: process exited 1)" });

    await dispatch(path, { worker: "fork", task: "Again." });
    h.workers.starts[1]!.settle({ output: "", stopReason: "error" });
    await h.end("child-2", "error");
    expect(h.workers.continues).toEqual([{ childId: "child-2", text: REPORT_RE_REQUEST, parentSessionId: "S1" }]);
    expect(h.warnings).toEqual([]);
  });

  it("asks nothing after a clean end, whether the report came with the result or in the final text", async () => {
    const path = await h.open({ budget: { worker_runs: 2 } });
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", structured: sampleReport() });
    await h.end("child-1", "completed");
    expect(h.workers.continues).toEqual([]);
    expect((await h.record(path)).attempts[0]).toMatchObject({ status: "completed", report: REPORT_PATH });

    await dispatch(path, { task: "Now the decamer.", continue: "child-1" });
    expect(h.workers.continues).toHaveLength(1);
    await h.end("child-1", "completed", jsonBlock(sampleReport({ summary: "Decamer built." })));
    expect(h.workers.continues).toHaveLength(1);
    expect((await h.record(path)).attempts[1]).toMatchObject({ status: "completed", summary: "Decamer built.", report: "knowledges/worker-report-2026-11-04-child-1-r2.md" });
    expect(h.warnings).toEqual([]);
  });

  it("leaves the attempt settled, with a warning, when the worker cannot be asked", async () => {
    const path = await h.open();
    await dispatch(path);
    h.workers.starts[0]!.settle({ output: "", stopReason: "error" });
    h.workers.failNextContinue("subagent is not resumable");
    await h.end("child-1", "error");
    expect(h.workers.continues).toEqual([]);
    expect((await h.record(path)).attempts[0]).toMatchObject({ status: "error", ended_at: NOW, check: "unreported: the worker produced no output (the worker ended with error)" });
    expect(h.warnings).toEqual([expect.stringMatching(/worker child-1 ended without a report and could not be asked for it .*: subagent is not resumable/)]);
  });
});
