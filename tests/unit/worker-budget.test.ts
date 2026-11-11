/**
 * Worker runs are held to the delegation a session works on. A session bound
 * to a delegation starts workers through research_dispatch only (the native
 * subagent tools are refused there); a dispatched start is charged and
 * recorded as an attempt, which the child's end closes; a worker session
 * keeps to a worker's tools; a session with no delegation is left alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { block, resume, transition } from "../../packages/research/src/delegation/model.js";
import { type Call, NOW, researchHarness, type ResearchHarness } from "../research-harness.js";

let h: ResearchHarness;

const worker = (session = "S1", name = "subagent_claude_code", header?: Call["agent"] extends { session: { header?: infer H } } | undefined ? H : never): Call => ({
  name,
  arguments: { description: "Align the numbers", prompt: "Recompute table 2 from the run outputs." },
  agent: { session: { id: session, ...(header !== undefined && { header }) } },
});
const child = (name: string, session = "child-1"): Call => ({ name, arguments: {}, agent: { session: { id: session, header: { origin: "subagent", parentSession: "S1" } } } });

const dispatch = (path: string, session = "S1", over: Record<string, unknown> = {}) =>
  h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Build the trimer", task: "Build the trimer from the unit.", expected: ["trimer.pdb"], ...over }, session);

describe("worker starts in a research session", () => {
  beforeEach(async () => {
    h = await researchHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("leaves a session with no delegation, and tools that start no worker, alone", async () => {
    await h.open({ budget: { worker_runs: 0 } });
    expect((await h.pre(worker("S2"))).kind).toBe("allow");
    expect((await h.pre({ name: "bash", arguments: { command: "ls" }, agent: { session: { id: "S1" } } })).kind).toBe("allow");
    expect((await h.pre({ name: "list_subagent_models", arguments: {}, agent: { session: { id: "S1" } } })).kind).toBe("allow");
    expect((await h.pre({ name: "research_status", arguments: {} })).kind).toBe("allow");
  });

  it("refuses the native subagent tools in a session bound to a delegation and points at research_dispatch", async () => {
    const path = await h.open();
    for (const name of ["subagent", "subagent_fork", "subagent_claude_code", "subagent_codex"]) {
      const decision = await h.pre(worker("S1", name));
      expect(decision.kind).toBe("deny");
      if (decision.kind !== "deny") continue;
      expect(decision.info).toEqual({ name: "TackUseDispatch", code: "TACK_USE_DISPATCH" });
      expect(decision.reason).toContain("research_dispatch");
      expect(decision.reason).toContain(path);
      expect(decision.reason).toContain(name);
    }
    expect((await h.record(path)).attempts).toEqual([]);
  });

  it("keeps a worker session to a worker's tools, and lets it run compute on its parent's delegation", async () => {
    const path = await h.open();
    await dispatch(path);
    expect(h.ledger.current("child-1")).toBe(path);
    for (const name of ["research_open", "research_plan", "research_assess", "research_report", "research_decide", "research_resume", "research_retract", "research_pause", "research_wait", "research_status", "research_dispatch", "molab_cancel_execution"]) {
      const decision = await h.pre(child(name));
      expect(decision.kind, name).toBe("deny");
      if (decision.kind !== "deny") continue;
      expect(decision.info).toEqual({ name: "TackWorkerScope", code: "TACK_WORKER_SCOPE" });
      expect(decision.reason).toContain("final report");
    }
    for (const name of ["research_context", "research_audit", "molab_create_experiment", "molab_create_run", "molab_read_outputs", "molab_dry_run", "bash", "read"]) {
      expect((await h.pre(child(name))).kind, name).toBe("allow");
    }
    const nested = await h.pre(child("subagent"));
    expect(nested.kind).toBe("deny");
    if (nested.kind === "deny") expect(nested.reason).toContain("does not start workers");
    // A worker of no delegation (started elsewhere) is only kept from the supervisor's tools.
    expect((await h.pre(child("subagent", "child-free"))).kind).toBe("allow");
  });

  it("charges a dispatched start, records its attempt, and closes it when the child ends", async () => {
    const path = await h.open();
    await dispatch(path);
    let record = await h.record(path);
    expect(record.spent.worker_runs).toBe(1);
    expect(record.attempts).toEqual([
      expect.objectContaining({ id: "child-1", worker: "spawn", task: "Build the trimer", status: "running", started_at: NOW, brief: expect.stringMatching(/^knowledges\/brief-/) }),
    ]);
    expect(record.attempts[0]!.ended_at ?? undefined).toBeUndefined();

    await h.end("child-1", "completed", "Trimer built; 205 atoms.");
    record = await h.record(path);
    expect(record.attempts[0]).toMatchObject({ status: "completed", summary: "Trimer built; 205 atoms.", ended_at: NOW });
    expect(record.attempts[0]!.cost_usd ?? undefined).toBeUndefined();
    expect(record.spent.worker_usd).toBe(0);
    // A later epoch of the same child neither re-closes nor charges.
    await h.end("child-1", "error");
    expect((await h.record(path)).attempts[0]!.status).toBe("completed");
    expect(h.warnings).toEqual([]);
  });

  it("refuses a start once worker_runs is spent, telling the model how to get more", async () => {
    const path = await h.open({ budget: { worker_runs: 1 } });
    await dispatch(path);
    await expect(dispatch(path)).rejects.toThrow(/Not started: budget exhausted: worker_runs has 0 left[\s\S]*ask_human[\s\S]*tack research amend .* --budget worker_runs=/);
    expect((await h.record(path)).spent.worker_runs).toBe(1);
  });

  it("holds a start in flight against the budget, and frees it when the start fails", async () => {
    const path = await h.open({ budget: { worker_runs: 1 } });
    const held = h.workers.holdNextStart();
    const first = dispatch(path);
    await new Promise((done) => setTimeout(done, 50));
    expect(h.ledger.inFlight(path)).toBe(1);
    await expect(dispatch(path)).rejects.toThrow(/1 worker start is already in flight; budget exhausted/);
    held.release();
    await first;
    expect(h.ledger.inFlight(path)).toBe(0);

    const second = await h.open({ budget: { worker_runs: 1 }, name: "Order study" });
    h.workers.failNextStart("provider unavailable");
    await expect(dispatch(second)).rejects.toThrow(/provider unavailable/);
    expect(h.ledger.inFlight(second)).toBe(0);
    expect((await h.record(second)).spent.worker_runs).toBe(0);
    await dispatch(second);
    expect((await h.record(second)).spent.worker_runs).toBe(1);
  });

  it("refuses a start when worker_usd is used up", async () => {
    const path = await h.open({ budget: { worker_usd: 0 } });
    await expect(dispatch(path)).rejects.toThrow(new RegExp(`worker_usd has 0 left[\\s\\S]*tack research amend ${path} --budget worker_usd=`));
  });

  it("refuses a start the delegation was not granted delegate_worker for", async () => {
    const path = await h.open({ budget: { worker_runs: 5 }, actions: ["read", "write_knowledge"] });
    await expect(dispatch(path)).rejects.toThrow(/research_dispatch needs the "delegate_worker" action/);
    expect(path).toBeTruthy();
  });

  it("refuses a start while the delegation is paused, blocked or closed", async () => {
    const path = await h.open({ budget: { worker_runs: 5 } });
    await h.store.update(path, (record) => transition(record, "paused"));
    await expect(dispatch(path)).rejects.toThrow(/paused; resume it/);
    await h.store.update(path, (record) => block(resume(record), ["Which basis set?"]));
    await expect(dispatch(path)).rejects.toThrow(/blocked on a person: Which basis set\?/);
    await h.store.update(path, (record) => transition(record, "done"));
    await expect(dispatch(path)).rejects.toThrow(/the delegation is done[\s\S]*research_open/);
    await expect(h.call("research_report", { delegation: path, name: "Late gap", summary: "s", body: "b", evidence: ["scratch/a.txt"] })).rejects.toThrow(/must be recorded before closing/);
  });

  it("follows the delegation a session last named, and binds the worker's session to its starter's delegation", async () => {
    const first = await h.open({ budget: { worker_runs: 0 } });
    const second = await h.open({ budget: { worker_runs: 1 }, name: "Order study" }, "S9");
    expect(h.ledger.current("S1")).toBe(first);
    await expect(h.call("research_status", { delegation: "knowledges/missing.md" })).rejects.toThrow();
    expect(h.ledger.current("S1")).toBe(first);
    await h.call("research_status", { delegation: second });
    expect(h.ledger.current("S1")).toBe(second);
    await dispatch(second);
    expect(h.ledger.current("child-1")).toBe(second);
    expect((await h.record(first)).spent.worker_runs).toBe(0);
    expect((await h.record(second)).spent.worker_runs).toBe(1);
    expect(h.workers.starts[0]!.request.parentSessionId).toBe("S1");
  });
});
