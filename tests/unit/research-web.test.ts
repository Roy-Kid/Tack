import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { block } from "../../packages/research/src/delegation/model.js";
import { researchRequest } from "../../packages/research/src/dsh/web.js";
import { researchHarness, type ResearchHarness } from "../research-harness.js";
import { WorkerLedger } from "../../packages/research/src/workers.js";

let h: ResearchHarness;
beforeEach(async () => { h = await researchHarness(); });
afterEach(async () => { await h.close(); });

async function action(path: string, action: string, fields: Record<string, unknown> = {}) {
  return researchRequest(h.deps, new Request("http://localhost/api/tack/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, delegation: path, digest: (await h.store.get(path)).digest, ...fields }),
  }));
}

describe("research browser API", () => {
  it("tracks in-place Plan revisions independently of delegation activity", async () => {
    const path = await h.open({ plan: false }, "S1");
    const plan = "knowledges/graph-plan.md";
    const first = { nodes: [{ id: "input", type: "input", data: { title: "Input" } }], edges: [] };
    h.molab.plantDoc(plan, { cls: "Plan", name: "Plan", record: { workflow: first } });
    await h.store.update(path, record => ({ ...record, current_plan: plan }));
    const read = async () => (await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1"))).json() as Promise<{ planRevision: string; item: { record: { current_plan: string } }; workflow: typeof first }>;
    const before = await read();
    expect(before.planRevision).toBe((await h.deps.molab.getRecord(plan)).digest);
    await h.store.update(path, record => ({ ...record, goal: "Updated supervision note" }));
    expect((await read()).planRevision).toBe(before.planRevision);
    h.molab.plantDoc(plan, { cls: "Plan", name: "Plan", record: { workflow: { ...first, nodes: [{ ...first.nodes[0]!, data: { title: "Revised input" } }] } } });
    const after = await read();
    expect(after.planRevision).not.toBe(before.planRevision);
    expect(after.item.record.current_plan).toBe(before.item.record.current_plan);
    expect(after.workflow.nodes).toEqual([{ id: "input", type: "input", data: { title: "Revised input" } }]);
  });

  it("writes the workbench graph through research_plan and revokes approval when only the graph changes", async () => {
    const path = await h.open({ plan: false }, "S1");
    const workflow = { nodes: [{ id: "input", type: "input", data: { title: "Input" } }, { id: "evaluate", type: "tool", data: { title: "Evaluate" } }], edges: [{ sourceNodeID: "input", targetNodeID: "evaluate" }] };
    const args = { delegation: path, name: "Graph plan", hypothesis: "Test the candidate", comparison: "Against the baseline", fixed: ["dataset"], varied: ["candidate"], runs: "One controlled run", judgement: "Compare the metrics", products: ["report"], parameters: [], no_parameters_reason: "No simulation parameters are fixed", workflow };
    await h.call("research_plan", args, "S1");
    const plan = (await h.record(path)).current_plan!;
    expect((await h.deps.molab.getRecord(plan)).record.workflow).toEqual(workflow);
    await h.approve(path, "plan", plan);
    const revised = { ...workflow, nodes: [workflow.nodes[0]!, { ...workflow.nodes[1]!, data: { title: "Evaluate quality" } }] };
    await h.call("research_plan", { ...args, workflow: revised, reason: "Clarify the quality gate" }, "S1");
    expect((await h.record(path)).state).toBe("blocked");
    expect((await h.record(path)).approvals).toEqual([]);
    expect((await h.record(path)).current_plan).toBe(plan);
    await h.approve(path, "plan", plan);
    const before = (await h.deps.molab.getRecord(plan)).digest;
    await expect(h.call("research_plan", { ...args, workflow: { ...workflow, edges: [{ sourceNodeID: "input", targetNodeID: "missing" }] }, reason: "Invalid connection" }, "S1")).rejects.toThrow(/missing node/);
    expect((await h.deps.molab.getRecord(plan)).digest).toBe(before);
    const { workflow: _graph, ...textOnly } = args;
    await h.call("research_plan", { ...textOnly, reason: "Use a text-only Plan" }, "S1");
    expect((await h.deps.molab.getRecord(plan)).record.workflow).toBe(null);
  });

  it("does not expose a workbench marker on an unbound conversation", async () => {
    await h.open({ plan: false }, "other-session");
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=unmarked&binding=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ binding: null });
    expect((await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=unmarked"))).status).toBe(404);
  });

  it("loads only the one experiment linked to the marked conversation", async () => {
    const first = await h.open({ name: "First experiment", plan: false }, "S1");
    await h.open({ name: "Second experiment", plan: false }, "S2");
    h.molab.plantDoc("knowledges/first-plan.md", { cls: "Plan", name: "First Plan", record: { workflow: {
      nodes: [{ id: "input", type: "input", data: { title: "Input" } }, { id: "evaluate", type: "tool", data: { title: "Evaluate" } }],
      edges: [{ sourceNodeID: "input", targetNodeID: "evaluate" }],
    } } });
    await h.store.update(first, record => ({ ...record, current_plan: "knowledges/first-plan.md" }));
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1"));
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({ binding: { sessionId: "S1", delegation: first }, item: { path: first }, workflow: { edges: [{ sourceNodeID: "input", targetNodeID: "evaluate" }] } });
    expect(value).not.toHaveProperty("delegations");
    expect(JSON.stringify(value)).not.toContain("Second experiment");
  });

  it("refuses an old binding and documents from another experiment", async () => {
    await h.open({ name: "First", plan: false }, "S1");
    const other = await h.open({ name: "Other", plan: false }, "S2");
    expect((await researchRequest(h.deps, new Request(`http://localhost/api/tack/research?session=S1&delegation=${encodeURIComponent(other)}`))).status).toBe(409);
    expect((await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&document=knowledges/other-plan.md"))).status).toBe(403);
  });

  it("does not choose an arbitrary experiment after a restart loses explicit focus", async () => {
    await h.open({ name: "First", plan: false }, "S1");
    const second = await h.open({ name: "Second", plan: false }, "S1");
    const current = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&binding=1"));
    expect(await current.json()).toMatchObject({ binding: { delegation: second } });
    const restarted = { ...h.deps, ledger: new WorkerLedger(h.store, h.deps.now, h.deps.logger) };
    expect((await researchRequest(restarted, new Request("http://localhost/api/tack/research?session=S1"))).status).toBe(409);
  });

  it("keeps the Plan readable when workflow connections are invalid", async () => {
    const path = await h.open({ plan: false }, "S1");
    h.molab.plantDoc("knowledges/bad-workflow.md", { cls: "Plan", name: "Bad graph", body: "# Plan remains readable", record: { workflow: { nodes: [{ id: "input", type: "input", data: { title: "Input" } }], edges: [{ sourceNodeID: "input", targetNodeID: "missing" }] } } });
    await h.store.update(path, record => ({ ...record, current_plan: "knowledges/bad-workflow.md" }));
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1"));
    expect(await response.json()).toMatchObject({ workflow: null, workflowError: expect.stringContaining("invalid nodes or connections") });
    const document = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&document=knowledges/bad-workflow.md"));
    expect(await document.json()).toMatchObject({ body: "# Plan remains readable" });
  });

  it("reads stage dependencies and todo progress from Molab without inventing execution state", async () => {
    h.molab.plantDoc("knowledges/roadmap.md", { cls: "Roadmap", name: "Research stages", record: { stages: [
      { id: "collect", title: "Collect evidence", depends_on: [] },
      { id: "compare", title: "Compare", depends_on: ["collect"] },
    ] } });
    h.molab.plantDoc("knowledges/todo.md", { cls: "Todo", name: "Work items", record: { items: [{ id: "t1", stage: "collect", title: "Read sources", status: "done" }] } });
    const before = JSON.stringify([...h.molab.docs]);
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?campaign=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ roadmaps: [{ path: "knowledges/roadmap.md", stages: [
      { id: "collect", depends_on: [] }, { id: "compare", depends_on: ["collect"] },
    ] }], todos: [{ items: [{ id: "t1", stage: "collect", status: "done" }] }] });
    expect(JSON.stringify([...h.molab.docs])).toBe(before);
  });

  it("serves the research map only to a conversation bound to an experiment", async () => {
    await h.open({ plan: false }, "S1");
    const finding = "projects/p/experiments/sweep/knowledges/plateau.md";
    h.molab.plantDoc("knowledges/question.md", { cls: "Plan", name: "Why the plateau", body: "# Why does stability plateau?" });
    h.molab.plantDoc("knowledges/roadmap.md", { cls: "Roadmap", name: "Stages", record: { stages: [{ id: "sweep", title: "Loading sweep", experiment: "sweep", depends_on: [] }] }, edges: [{ target: "knowledges/question.md", role: "derived_from" }] });
    h.molab.plantDoc(finding, { cls: "Finding", name: "plateau", edges: [{ target: "knowledges/question.md", role: "derived_from" }, { target: "molab:asset/a1", role: "derived_from" }] });
    const before = JSON.stringify([...h.molab.docs]);
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&map=1"));
    expect(response.status).toBe(200);
    const { map } = await response.json() as { map: { nodes: { id: string; cls: string }[]; edges: { from: string; to: string; role: string }[] } };
    expect(map.nodes.map((node) => [node.id, node.cls])).toEqual([["knowledges/question.md", "Plan"], ["knowledges/roadmap.md", "Roadmap"], [finding, "Finding"]]);
    expect(map.edges).toEqual([
      { from: "knowledges/roadmap.md", to: "knowledges/question.md", role: "derived_from" },
      { from: finding, to: "knowledges/question.md", role: "derived_from" },
    ]);
    expect(JSON.stringify([...h.molab.docs])).toBe(before);
    expect((await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=unbound&map=1"))).status).toBe(404);
  });

  it("puts hypotheses with their verdicts and the evidence for and against them on the map", async () => {
    await h.open({ plan: false }, "S1");
    h.molab.plantDoc("knowledges/h1.md", { cls: "Hypothesis", name: "Crosslinking lowers dry FFV", record: { verdict: "refuted" } });
    h.molab.plantDoc("knowledges/ffv.md", { cls: "Finding", name: "ffv", edges: [{ target: "knowledges/h1.md", role: "contradicts" }] });
    h.molab.plantDoc("knowledges/ratio.md", { cls: "Decision", name: "Matched water ratio", record: { status: "open" } });
    h.molab.plantDoc("knowledges/capability-gaps.md", { cls: "Todo", name: "capability-gaps", record: { items: [], gaps: [] } });
    const { map } = await (await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&map=1"))).json() as { map: { nodes: { id: string; state: string | null }[]; edges: unknown[]; attention: { id: string }[] } };
    expect(map.nodes.map((node) => [node.id, node.state])).toEqual(expect.arrayContaining([["knowledges/h1.md", "refuted"], ["knowledges/ffv.md", null], ["knowledges/ratio.md", "open"]]));
    expect(map.edges).toContainEqual({ from: "knowledges/ffv.md", to: "knowledges/h1.md", role: "contradicts" });
    expect(map.attention.map((item) => item.id)).toContain("knowledges/ratio.md");
    // Tack's own backlog of tool gaps is not research content.
    expect(map.nodes.map((node) => node.id)).not.toContain("knowledges/capability-gaps.md");
  });

  it("reads the body of a document on the map and of nothing else", async () => {
    await h.open({ plan: false }, "S1");
    h.molab.plantDoc("projects/p/experiments/sweep/knowledges/plateau.md", { cls: "Finding", name: "plateau", body: "# A plateau appears above 0.2" });
    h.molab.plantDoc("knowledges/private-note.md", { cls: "Note", name: "private-note", body: "not research content" });
    const read = (path: string) => researchRequest(h.deps, new Request(`http://localhost/api/tack/research?session=S1&node=${encodeURIComponent(path)}`));
    const finding = await read("projects/p/experiments/sweep/knowledges/plateau.md");
    expect(finding.status).toBe(200);
    expect(await finding.json()).toMatchObject({ body: "# A plateau appears above 0.2" });
    expect((await read("knowledges/private-note.md")).status).toBe(403);
    expect((await read("knowledges/missing.md")).status).toBe(403);
  });

  it("serves a document on the map as the page Molab renders, sandboxed so it cannot act as the workbench", async () => {
    await h.open({ plan: false }, "S1");
    h.molab.plantDoc("knowledges/plain.md", { cls: "Finding", name: "plain", body: "# A finding & its evidence" });
    const page = (path: string) => researchRequest(h.deps, new Request(`http://localhost/api/tack/research?session=S1&page=1&node=${encodeURIComponent(path)}`));
    const rendered = await page("knowledges/plain.md");
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(rendered.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-popups");
    expect(await rendered.text()).toContain("<h1>plain</h1>");
    expect(h.molab.requests.some((request) => request.includes("/api/knowledge/doc/page"))).toBe(true);
    expect((await page("knowledges/private-note.md")).status).toBe(403);
  });

  it("names the experiment the conversation is bound to, so the map can mark it", async () => {
    const { experiment } = h.molab.seedRun();
    const path = await h.open({ plan: false }, "S1");
    await h.store.update(path, (record) => ({ ...record, scope: `molab:experiment/${experiment}` }));
    const name = (await h.deps.molab.listExperiments((await h.deps.molab.listProjects())[0]!.id)).find((entry) => entry.id === experiment)!.name;
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?session=S1&map=1"));
    expect(await response.json()).toMatchObject({ current: name });
  });

  it("reports malformed planning records without discarding readable plans", async () => {
    h.molab.plantDoc("knowledges/bad-roadmap.md", { cls: "Roadmap", name: "Bad stages", record: { stages: [{ title: "Missing stable id" }] } });
    h.molab.plantDoc("knowledges/plan.md", { cls: "Plan", name: "Plan", body: "# Research plan" });
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research?campaign=1"));
    expect(await response.json()).toMatchObject({ plans: [{ path: "knowledges/plan.md" }], unreadable: [{ path: "knowledges/bad-roadmap.md", error: expect.any(String) }] });
  });

  it("reads the served scope and delegation records without reconciling or writing", async () => {
    const path = await h.open({ plan: false });
    const before = JSON.stringify([...h.molab.docs]);
    const response = await researchRequest(h.deps, new Request("http://localhost/api/tack/research"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ scope: { kind: "workspace.project" }, delegations: [{ path, record: { state: "open" }, gate: null }] });
    expect(JSON.stringify([...h.molab.docs])).toBe(before);
  });

  it("keeps ordinary answers separate from approvals", async () => {
    const path = await h.open({ plan: false });
    await h.store.update(path, (record) => block(record, ["Review this plan"], { gate: "plan", target: "knowledges/plan.md" }));
    expect((await action(path, "answer", { answers: "Please change the seed to 42." })).status).toBe(200);
    const record = await h.record(path);
    expect(record.state).toBe("open");
    expect(record.approvals).toEqual([]);
    expect(record.answers.at(-1)?.text).toBe("Please change the seed to 42.");
    expect(record.supervisor.wake).toBe("pending");
  });

  it("approves only the pending gate and records the process identity", async () => {
    const path = await h.open({ plan: false });
    const gate = { gate: "plan" as const, target: "knowledges/plan.md" };
    await h.store.update(path, (record) => block(record, ["Review this plan"], gate));
    const response = await action(path, "approve", { gate, answers: "The protocol is ready." });
    expect(response.status).toBe(200);
    expect((await h.record(path)).approvals).toEqual([{ ...gate, by: expect.any(String), at: expect.any(String), note: "approve knowledges/plan.md\nThe protocol is ready." }]);
    expect((await h.record(path)).state).toBe("open");
  });

  it("refuses a stale snapshot and a mismatched approval target without writes", async () => {
    const path = await h.open({ plan: false });
    await h.store.update(path, (record) => block(record, ["Review"], { gate: "results", target: "knowledges/results.md" }));
    expect((await action(path, "approve", { gate: { gate: "plan", target: "knowledges/plan.md" } })).status).toBe(409);
    expect((await action(path, "answer", { digest: "old-revision", answers: "Yes" })).status).toBe(409);
    expect((await h.record(path)).approvals).toEqual([]);
    expect((await h.record(path)).state).toBe("blocked");
  });

  it("does not retry a reviewed action over a concurrent record change", async () => {
    const path = await h.open({ plan: false });
    const digest = (await h.store.get(path)).digest;
    await h.store.update(path, (record) => ({ ...record, goal: "A revised goal" }));
    await expect(h.store.update(path, (record) => ({ ...record, state: "paused" }), undefined, digest)).rejects.toThrow(/Refresh/);
    expect((await h.record(path)).state).toBe("open");
  });

  it("pauses and continues through research tools, preserving waits", async () => {
    const path = await h.open({ plan: false });
    await h.store.update(path, (record) => ({ ...record, state: "waiting", waits: [{ id: "w", target: "molab:run/r1", state: "pending", kind: "execution", on_resolve: "assess" }] }));
    expect((await action(path, "pause")).status).toBe(200);
    expect((await h.record(path)).state).toBe("paused");
    expect((await action(path, "resume")).status).toBe(200);
    expect((await h.record(path)).state).toBe("waiting");
    expect((await h.record(path)).waits[0]?.state).toBe("pending");
    expect((await h.record(path)).supervisor.wake).toBe("pending");
  });

  it("validates blank answers, unknown actions and identity injection", async () => {
    const path = await h.open({ plan: false });
    await h.store.update(path, (record) => block(record, ["Which seed?"]));
    expect((await action(path, "answer", { answers: " " })).status).toBe(400);
    expect((await action(path, "dispatch")).status).toBe(400);
    expect((await action(path, "answer", { answers: "42", by: "someone else" })).status).toBe(400);
    expect((await h.record(path)).state).toBe("blocked");
  });

  it("reads document bodies through Molab rather than the local filesystem", async () => {
    const path = await h.open();
    const plan = (await h.record(path)).current_plan!;
    const response = await researchRequest(h.deps, new Request(`http://localhost/api/tack/research?${new URLSearchParams({ document: plan })}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ relPath: plan, body: expect.stringContaining("## Hypothesis") });
  });
});
