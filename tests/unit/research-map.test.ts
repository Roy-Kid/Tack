import { describe, expect, it } from "@rstest/core";
import type { Campaign } from "../../packages/research/src/campaign.js";
import { foldedReferences, layoutResearchMap } from "../../packages/research/src/map-layout.js";
import type { KnowledgeGraph } from "../../packages/research/src/molab/schemas.js";
import { buildResearchMap } from "../../packages/research/src/research-map.js";

const node = (relPath: string, cls: string, name: string, excerpt = "", title = "") => ({ relPath, cls, name, title, excerpt, hostPath: "" });
const link = (source: string, target: string, role = "derived_from", kind = "document") => ({ source, target, role, kind });

const PLAN = "knowledges/plan.md";
const ROADMAP = "knowledges/roadmap.md";
const TODO = "knowledges/todo.md";
const MILESTONE = "knowledges/stage-1.md";
const FFV = "projects/p/experiments/porosity/knowledges/ffv.md";
const WATER = "projects/p/experiments/water-network/knowledges/water.md";
const REVISED = "knowledges/plan-rev2.md";

/** The shape of ~/work/pbix-aem: planning documents derived from the Plan, findings filed under experiments. */
const graph: KnowledgeGraph = {
  nodes: [
    node(PLAN, "Plan", "PBIX AEM modeling plan", "How do crosslinks change free volume?"),
    node(ROADMAP, "Roadmap", "roadmap"),
    node(TODO, "Todo", "todo"),
    node(MILESTONE, "Milestone", "Stage 1 equilibrated"),
    node(FFV, "Finding", "ffv-psd-dry-wet", "Dry FFV rises with crosslinking"),
    node(WATER, "Finding", "water-network-80c"),
    node(REVISED, "Plan", "Plan, revision 2"),
    node("knowledges/delegation.md", "Delegation", "delegation"),
    node("knowledges/brief.md", "Note", "brief"),
  ],
  edges: [
    link(ROADMAP, PLAN), link(TODO, PLAN), link(MILESTONE, PLAN),
    link(MILESTONE, FFV),
    link(REVISED, PLAN, "supersedes"), link(REVISED, FFV),
    link(FFV, "molab:asset/01a", "derived_from", "ref"),
    link(FFV, "https://doi.org/10.1/x", "cites", "external"),
    link(FFV, "knowledges/gone.md", "references", "missing"),
    link("knowledges/brief.md", PLAN),
    link(FFV, FFV, "references"),
    link(MILESTONE, PLAN),
  ],
};
const campaign: Campaign = {
  plans: [{ path: PLAN, excerpt: "How do crosslinks change free volume?" }],
  roadmaps: [{ path: ROADMAP, stages: [
    { id: "network", title: "Build networks", experiment: "crosslink-network", depends_on: [] },
    { id: "stage1", title: "Equilibrate", experiment: "crosslink-network", depends_on: ["network", "network", "missing"] },
    { id: "stage2", title: "FFV and pores", experiment: "porosity", depends_on: ["stage1"] },
  ] }, { path: "knowledges/other-roadmap.md", stages: [{ id: "network", title: "Repeated", depends_on: [] }] }],
  todos: [{ path: TODO, items: [
    { id: "build", title: "Build three networks", status: "done", stage: "network" },
    { id: "equilibrate", title: "Equilibrate legal cells", status: "blocked", stage: "stage1" },
    { id: "ffv", title: "Compute FFV", status: "done", stage: "stage2" },
  ] }],
  milestones: [{ path: MILESTONE, stage: "stage1", criterion: "Cells equilibrated", status: "open" }],
  unreadable: [{ path: "knowledges/bad.md", error: "no id" }],
};

describe("research map", () => {
  const map = buildResearchMap(graph, campaign);
  const at = (id: string) => map.nodes.find((entry) => entry.id === id)!;
  const has = (from: string, to: string, role: string) => map.edges.some((edge) => edge.from === from && edge.to === to && edge.role === role);

  it("makes every research document a node, and nothing that is not a knowledge document", () => {
    expect(map.nodes.map((entry) => entry.id)).toEqual([PLAN, ROADMAP, TODO, MILESTONE, FFV, WATER, REVISED]);
    expect(at(PLAN)).toMatchObject({ cls: "Plan", title: "PBIX AEM modeling plan", excerpt: "How do crosslinks change free volume?" });
    expect(at(FFV).host).toBe("porosity");
    expect(at(PLAN).host).toBeNull();
  });

  it("shows a document's display title, and its name only when it has none", () => {
    const titled = buildResearchMap({ nodes: [node("a.md", "Hypothesis", "h-dry-ffv", "", "交联降低干态自由体积"), node("b.md", "Finding", "ffv-psd")], edges: [] }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    expect(titled.nodes.map((entry) => entry.title)).toEqual(["交联降低干态自由体积", "ffv-psd"]);
  });

  it("breaks a long column into shorter ones, one class after another, without moving anything past what refers to it", () => {
    const many = [...Array(9).keys()].map((index) => node(`h${index}.md`, "Hypothesis", `h${index}`));
    const decisions = [...Array(5).keys()].map((index) => node(`d${index}.md`, "Decision", `d${index}`));
    const wide = buildResearchMap({
      nodes: [node("plan.md", "Plan", "plan"), ...decisions, ...many, node("finding.md", "Finding", "finding")],
      edges: [...many, ...decisions].map((doc) => link(doc.relPath, "plan.md")).concat([link("finding.md", "h0.md", "supports"), link("finding.md", "d0.md")]),
    }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    const laid = layoutResearchMap(wide);
    const x = (id: string) => laid.find((entry) => entry.id === id)!.x;
    const perColumn = new Map<number, number>();
    for (const entry of laid) perColumn.set(entry.x, (perColumn.get(entry.x) ?? 0) + 1);
    expect(Math.max(...perColumn.values())).toBeLessThanOrEqual(6);
    // Hypotheses come before decisions, and a class does not share a column with another unless both fit.
    expect(Math.max(...many.map((doc) => x(doc.relPath)))).toBeLessThan(Math.min(...decisions.map((doc) => x(doc.relPath))));
    for (const edge of wide.edges) expect(x(edge.to)).toBeLessThan(x(edge.from));
  });

  it("draws an arrow for every link between two nodes, in the direction of the reference, with the link's role", () => {
    expect(has(ROADMAP, PLAN, "derived_from")).toBe(true);
    expect(has(MILESTONE, FFV, "derived_from")).toBe(true);
    expect(has(REVISED, PLAN, "supersedes")).toBe(true);
    expect(has(PLAN, ROADMAP, "derived_from")).toBe(false);
    // Links from hidden documents, self-links and links that leave the map are not arrows; the same link twice is one arrow.
    expect(map.edges).toHaveLength(6);
    expect(map.edges.filter((edge) => edge.from === MILESTONE && edge.to === PLAN)).toHaveLength(1);
  });

  it("keeps a document's references that leave the map, for its preview", () => {
    expect(at(FFV).refs).toEqual([
      { target: "molab:asset/01a", role: "derived_from", kind: "ref" },
      { target: "https://doi.org/10.1/x", role: "cites", kind: "external" },
      { target: "knowledges/gone.md", role: "references", kind: "missing" },
    ]);
    expect(at(PLAN).refs).toEqual([]);
  });

  it("reads status from the records, never from the graph", () => {
    expect(at(ROADMAP)).toMatchObject({ status: "blocked", note: "2 of 3 stages done" });
    expect(at(TODO)).toMatchObject({ status: "blocked", note: "2 of 3 items done" });
    expect(at(MILESTONE)).toMatchObject({ status: "open", note: "Closes Equilibrate" });
    expect(at(FFV)).toMatchObject({ status: null, note: "Filed under porosity" });
    expect(map.stages.map((stage) => [stage.id, stage.title, stage.status, stage.dependsOn])).toEqual([
      ["network", "Build networks", "done", []], ["stage1", "Equilibrate", "blocked", ["network"]], ["stage2", "FFV and pores", "done", ["stage1"]],
    ]);
    expect(map.attention).toEqual([{ id: "equilibrate", title: "Equilibrate legal cells", stage: "stage1", node: ROADMAP }]);
    expect(map.milestones).toEqual({ met: 0, total: 1 });
    expect(map.unreadable).toEqual(campaign.unreadable);
  });

  it("reads a hypothesis's verdict and a decision's status from their records, and asks a person for every open decision", () => {
    const H = "knowledges/h-dry-ffv.md";
    const D_OPEN = "knowledges/d-mass-ratio.md";
    const D_MADE = "knowledges/d-water-model.md";
    const reasoned = buildResearchMap({
      nodes: [node(PLAN, "Plan", "plan"), node(H, "Hypothesis", "Crosslinking lowers dry FFV"), node(FFV, "Finding", "ffv"), node(D_OPEN, "Decision", "Matched water ratio"), node(D_MADE, "Decision", "Flexible TIP3P")],
      edges: [link(H, PLAN), link(FFV, H, "contradicts"), link(D_OPEN, FFV), link(FFV, D_MADE)],
    }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] }, { [H]: { verdict: "refuted" }, [D_OPEN]: { status: "open" }, [D_MADE]: {} });
    const state = (id: string) => reasoned.nodes.find((entry) => entry.id === id)!.state;
    expect(state(H)).toBe("refuted");
    expect(state(D_OPEN)).toBe("open");
    // A record that does not say is the class's default, as Molab reads it.
    expect(state(D_MADE)).toBe("made");
    expect(state(FFV)).toBeNull();
    expect(reasoned.edges).toContainEqual({ from: FFV, to: H, role: "contradicts" });
    expect(reasoned.attention).toEqual([{ id: D_OPEN, title: "Matched water ratio", stage: null, node: D_OPEN }]);
    // Evidence sits to the right of the claim it judges; an open decision to the right of what prompted it.
    const laid = layoutResearchMap(reasoned);
    const x = (id: string) => laid.find((entry) => entry.id === id)!.x;
    expect(x(PLAN)).toBeLessThan(x(H));
    expect(x(H)).toBeLessThan(x(FFV));
    expect(x(FFV)).toBeLessThan(x(D_OPEN));
    expect(foldedReferences(reasoned)).toEqual([false, false, false, false]);
  });

  it("does not mutate its input and is empty, not broken, for an empty workspace", () => {
    const before = JSON.stringify([graph, campaign]);
    buildResearchMap(graph, campaign);
    expect(JSON.stringify([graph, campaign])).toBe(before);
    const empty = buildResearchMap({ nodes: [], edges: [] }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    expect(empty).toMatchObject({ nodes: [], edges: [], stages: [], attention: [], milestones: { met: 0, total: 0 } });
    expect(layoutResearchMap(empty)).toEqual([]);
  });
});

describe("research map layout", () => {
  const map = buildResearchMap(graph, campaign);
  const placed = layoutResearchMap(map);
  const at = (id: string) => placed.find((entry) => entry.id === id)!;

  it("places every node once, each to the right of everything it rests on", () => {
    expect(placed.map((entry) => entry.id).sort()).toEqual(map.nodes.map((entry) => entry.id).sort());
    for (const edge of map.edges) expect([edge.from, edge.to, at(edge.to).x < at(edge.from).x]).toEqual([edge.from, edge.to, true]);
  });

  it("does not let a mention move a document: the plan stays leftmost though it cites literature", () => {
    const cited = buildResearchMap({
      nodes: [node("plan.md", "Plan", "plan"), node("paper.md", "Literature", "paper"), node("finding.md", "Finding", "finding")],
      edges: [link("plan.md", "paper.md", "cites"), link("finding.md", "plan.md"), link("finding.md", "paper.md", "cites")],
    }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    const laid = layoutResearchMap(cited);
    const x = (id: string) => laid.find((entry) => entry.id === id)!.x;
    expect(x("plan.md")).toBe(0);
    expect(x("finding.md")).toBeGreaterThan(x("plan.md"));
    // A document nothing rests on, and that rests on nothing, sits in the first column.
    expect(x("paper.md")).toBe(0);
  });

  it("never overlaps two nodes", () => {
    for (const a of placed) for (const b of placed) {
      if (a.id >= b.id) continue;
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect([a.id, b.id, apart]).toEqual([a.id, b.id, true]);
    }
  });

  it("gives each class of document its own shape", () => {
    expect(at(PLAN).shape).toBe("question");
    expect(at(ROADMAP).shape).toBe("card");
    expect(at(FFV).shape).toBe("pill");
  });

  it("folds away a reference another chain of references already implies, and every mere mention", () => {
    const folded = foldedReferences(map);
    const state = (from: string, to: string) => folded[map.edges.findIndex((edge) => edge.from === from && edge.to === to)];
    // The milestone rests on the finding and on the plan directly: both are its only route to each, so both stay.
    expect(state(MILESTONE, FFV)).toBe(false);
    expect(state(ROADMAP, PLAN)).toBe(false);
    expect(state(REVISED, PLAN)).toBe(false);
    const chain = buildResearchMap({
      nodes: [node("plan.md", "Plan", "plan"), node("finding.md", "Finding", "finding"), node("report.md", "Report", "report"), node("paper.md", "Literature", "paper")],
      edges: [link("finding.md", "plan.md"), link("report.md", "finding.md"), link("report.md", "plan.md"), link("finding.md", "paper.md", "cites"), link("report.md", "paper.md", "references")],
    }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    expect(chain.edges.map((edge, index) => [edge.from, edge.to, foldedReferences(chain)[index]])).toEqual([
      ["finding.md", "plan.md", false],
      ["report.md", "finding.md", false],
      ["report.md", "plan.md", true],
      ["finding.md", "paper.md", true],
      ["report.md", "paper.md", true],
    ]);
  });

  it("keeps only the nearest column's arrows when more than six documents rest on the same one", () => {
    const hypotheses = [...Array(5).keys()].map((index) => node(`h${index}.md`, "Hypothesis", `h${index}`));
    const decisions = [...Array(4).keys()].map((index) => node(`d${index}.md`, "Decision", `d${index}`));
    const hub = buildResearchMap({
      nodes: [node("plan.md", "Plan", "plan"), ...hypotheses, ...decisions],
      edges: [...hypotheses, ...decisions].map((doc) => link(doc.relPath, "plan.md")),
    }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    const folded = foldedReferences(hub);
    expect(hub.edges.filter((_edge, index) => !folded[index]).map((edge) => edge.from)).toEqual(hypotheses.map((doc) => doc.relPath));
    // Six or fewer is not a crowd: every arrow stays.
    const few = buildResearchMap({ nodes: [node("plan.md", "Plan", "plan"), ...hypotheses], edges: hypotheses.map((doc) => link(doc.relPath, "plan.md")) }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    expect(foldedReferences(few)).toEqual(hypotheses.map(() => false));
  });

  it("does not fold both halves of a circle", () => {
    const circular = buildResearchMap({ nodes: [node("a.md", "Finding", "a"), node("b.md", "Finding", "b")], edges: [link("a.md", "b.md"), link("b.md", "a.md")] }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    expect(foldedReferences(circular)).toEqual([false, false]);
  });

  it("terminates when documents refer to each other in a circle", () => {
    const circular = buildResearchMap({ nodes: [node("a.md", "Finding", "a"), node("b.md", "Finding", "b")], edges: [link("a.md", "b.md"), link("b.md", "a.md")] }, { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] });
    const laid = layoutResearchMap(circular);
    expect(laid.map((entry) => entry.id).sort()).toEqual(["a.md", "b.md"]);
    expect(new Set(laid.map((entry) => entry.x)).size).toBe(2);
  });
});
