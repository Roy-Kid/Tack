/**
 * The research map a workbench draws. Every node is a knowledge document
 * Molab holds, and every arrow is a link one document makes to another, in
 * the direction of the reference and with the role the link declares. Molab's
 * knowledge graph is the model: Tack adds no class, no relation and no node of
 * its own. Experiments, runs and assets are Molab's workflow and workspace;
 * a document's references to them are listed with the document, not drawn.
 *
 * Status is read from the planning records, never inferred from the graph.
 */
import type { Campaign } from "./campaign.js";
import type { KnowledgeGraph } from "./molab/schemas.js";

export type StageStatus = "done" | "blocked" | "active" | "open";

/** The classes that are research content. Delegations, briefs and plain notes are operational records. */
export const MAP_CLASSES: ReadonlySet<string> = new Set(["Plan", "Hypothesis", "Roadmap", "Todo", "Milestone", "Observation", "Decision", "Finding", "Report", "Literature"]);

/**
 * The classes whose record carries the state of the reasoning: the field that
 * holds it and what Molab reads when the record does not say.
 */
export const STATEFUL: Readonly<Record<string, { field: string; initial: string }>> = {
  Hypothesis: { field: "verdict", initial: "open" },
  Decision: { field: "status", initial: "made" },
};
const OPEN = "open";

export interface MapNode {
  /** The document's workspace path. */
  id: string;
  /** The document's Molab class. */
  cls: string;
  title: string;
  excerpt: string;
  status: StageStatus | null;
  /** One recorded fact worth a line on the node. */
  note: string;
  /** A Hypothesis's verdict (`open`, `supported`, `refuted`, `unsettled`) or a Decision's status (`open`, `made`); null for every other class. */
  state: string | null;
  /** The experiment this document is filed under, by name. */
  host: string | null;
  /** The document's references that leave the map: workspace entities, URLs, files no document has. */
  refs: { target: string; role: string; kind: string }[];
}

export interface MapEdge {
  /** The document that makes the reference. */
  from: string;
  /** The document referred to. */
  to: string;
  /** The link's Molab role. */
  role: string;
}

export interface MapStage {
  id: string;
  title: string;
  dependsOn: string[];
  experiment: string | null;
  status: StageStatus;
  milestone: { path: string; status: string; criterion: string } | null;
  todo: { done: number; total: number };
  items: { id: string; title: string; status: string }[];
  /** The Roadmap document that defines this stage. */
  roadmap: string;
}

export interface ResearchMap {
  nodes: MapNode[];
  edges: MapEdge[];
  stages: MapStage[];
  /** What waits for a person: blocked work items and open decisions. `node` is the document to open for it. */
  attention: { id: string; title: string; stage: string | null; node: string | null }[];
  milestones: { met: number; total: number };
  unreadable: Campaign["unreadable"];
}

const EXPERIMENT_KNOWLEDGE = /(?:^|\/)experiments\/([^/]+)\/knowledges\//;
const MET = "met";

function stageStatus(items: readonly { status: string }[], milestone: MapStage["milestone"], experiment: string | null): StageStatus {
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (milestone?.status === MET) return "done";
  if (items.length > 0 && items.every((item) => item.status === "done")) return "done";
  if (experiment !== null || items.some((item) => item.status === "done")) return "active";
  return "open";
}

/** A set of parts is blocked if one is, done if all are, otherwise under way. */
function rollUp(statuses: readonly string[]): StageStatus {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length > 0 && statuses.every((status) => status === "done")) return "done";
  return statuses.some((status) => status === "done" || status === "active") ? "active" : "open";
}

function readStages(campaign: Campaign): MapStage[] {
  const every = campaign.roadmaps.flatMap((roadmap) => roadmap.stages.map((stage) => ({ stage, roadmap: roadmap.path })));
  // A stage id names one stage: the first roadmap to define it wins.
  const unique = every.filter((entry, index) => every.findIndex((other) => other.stage.id === entry.stage.id) === index);
  const known = new Set(unique.map((entry) => entry.stage.id));
  const items = campaign.todos.flatMap((todo) => todo.items);
  return unique.map(({ stage, roadmap }) => {
    const own = items.filter((item) => item.stage === stage.id).map((item) => ({ id: item.id, title: item.title, status: item.status }));
    const closing = campaign.milestones.find((milestone) => milestone.stage === stage.id);
    const milestone = closing === undefined ? null : { path: closing.path, status: closing.status, criterion: closing.criterion };
    const experiment = stage.experiment ?? null;
    return {
      id: stage.id,
      title: stage.title,
      dependsOn: [...new Set(stage.depends_on)].filter((id) => known.has(id) && id !== stage.id),
      experiment,
      status: stageStatus(own, milestone, experiment),
      milestone,
      todo: { done: own.filter((item) => item.status === "done").length, total: own.length },
      items: own,
      roadmap,
    };
  });
}

/** What the planning records say about one document: its status and one line for its node. */
function recorded(path: string, campaign: Campaign, stages: readonly MapStage[]): Pick<MapNode, "status" | "note"> {
  const roadmap = campaign.roadmaps.find((entry) => entry.path === path);
  if (roadmap !== undefined) {
    const own = stages.filter((stage) => stage.roadmap === path);
    return { status: rollUp(own.map((stage) => stage.status)), note: `${own.filter((stage) => stage.status === "done").length} of ${own.length} stages done` };
  }
  const todo = campaign.todos.find((entry) => entry.path === path);
  if (todo !== undefined) {
    return { status: rollUp(todo.items.map((item) => item.status)), note: `${todo.items.filter((item) => item.status === "done").length} of ${todo.items.length} items done` };
  }
  const milestone = campaign.milestones.find((entry) => entry.path === path);
  if (milestone !== undefined) {
    const stage = stages.find((entry) => entry.id === milestone.stage);
    return { status: milestone.status === MET ? "done" : "open", note: `Closes ${stage?.title || milestone.stage}` };
  }
  return { status: null, note: "" };
}

/**
 * Build the map from Molab's knowledge graph, the planning records, and the
 * records of the documents in {@link STATEFUL} classes, by path.
 */
export function buildResearchMap(graph: KnowledgeGraph, campaign: Campaign, records: Readonly<Record<string, Record<string, unknown>>> = {}): ResearchMap {
  const stages = readStages(campaign);
  const docs = graph.nodes.filter((doc) => MAP_CLASSES.has(doc.cls));
  const shown = new Set(docs.map((doc) => doc.relPath));
  const onMap = (edge: KnowledgeGraph["edges"][number]): boolean => edge.kind === "document" && shown.has(edge.target);

  const nodes: MapNode[] = docs.map((doc) => {
    const host = doc.relPath.match(EXPERIMENT_KNOWLEDGE)?.[1] ?? null;
    const facts = recorded(doc.relPath, campaign, stages);
    const stateful = STATEFUL[doc.cls];
    const value = stateful === undefined ? undefined : records[doc.relPath]?.[stateful.field];
    return {
      id: doc.relPath,
      cls: doc.cls,
      title: doc.title !== "" ? doc.title : doc.name,
      excerpt: doc.excerpt,
      status: facts.status,
      note: facts.note !== "" ? facts.note : host === null ? "" : `Filed under ${host}`,
      state: stateful === undefined ? null : typeof value === "string" && value !== "" ? value : stateful.initial,
      host,
      refs: graph.edges.filter((edge) => edge.source === doc.relPath && !onMap(edge)).map((edge) => ({ target: edge.target, role: edge.role, kind: edge.kind })),
    };
  });

  const links = graph.edges.filter((edge) => onMap(edge) && shown.has(edge.source) && edge.source !== edge.target).map((edge) => ({ from: edge.source, to: edge.target, role: edge.role }));
  const key = (edge: MapEdge): string => `${edge.from}\n${edge.to}\n${edge.role}`;
  const edges = links.filter((edge, index) => links.findIndex((other) => key(other) === key(edge)) === index);

  return {
    nodes,
    edges,
    stages,
    attention: [
      ...campaign.todos.flatMap((todo) => todo.items).filter((item) => item.status === "blocked").map((item) => ({ id: item.id, title: item.title, stage: item.stage ?? null, node: stages.find((stage) => stage.id === item.stage)?.roadmap ?? null })),
      ...nodes.filter((node) => node.cls === "Decision" && node.state === OPEN).map((node) => ({ id: node.id, title: node.title, stage: null, node: node.id })),
    ],
    milestones: { met: campaign.milestones.filter((milestone) => milestone.status === MET).length, total: campaign.milestones.length },
    unreadable: campaign.unreadable,
  };
}
