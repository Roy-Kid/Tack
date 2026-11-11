/**
 * Deterministic placement of a research map. A document sits one column right
 * of the deepest document it rests on (`derived_from`, `supersedes`), so those
 * arrows point left, back to their footing; rows in a column follow where
 * their references sit. A mention (`cites`, `records`, `references`) is drawn
 * wherever its two documents already are. Shared with the workbench
 * client, which hands the positions to its graph canvas.
 */
import type { MapNode, ResearchMap } from "./research-map.js";

export type MapShape = "question" | "card" | "pill";

export interface PlacedNode {
  id: string;
  shape: MapShape;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAP_SHAPE_SIZE: Record<MapShape, { width: number; height: number }> = {
  question: { width: 240, height: 124 },
  card: { width: 224, height: 104 },
  pill: { width: 264, height: 46 },
};
const CARDS: ReadonlySet<string> = new Set(["Hypothesis", "Decision", "Roadmap", "Todo", "Milestone", "Report"]);
const COLUMN_GAP = 84;
const ROW_GAP = 22;

/** Each class of document has its own shape, so the map reads without labels. */
export function shapeOf(node: MapNode): MapShape {
  if (node.cls === "Plan") return "question";
  return CARDS.has(node.cls) ? "card" : "pill";
}

/** The roles that say one document rests on, revises or judges another. The others (`cites`, `records`, `references`) are mentions. */
const STRUCTURAL: ReadonlySet<string> = new Set(["derived_from", "supersedes", "supports", "contradicts"]);

/** Longest chain of structural references leaving each node; a circle is cut where it closes. A mention moves nothing. */
function depths(map: ResearchMap): Map<string, number> {
  const sources = new Map<string, string[]>(map.nodes.map((node) => [node.id, []]));
  for (const edge of map.edges) if (STRUCTURAL.has(edge.role)) sources.get(edge.from)?.push(edge.to);
  const done = new Map<string, number>();
  const visit = (id: string, path: ReadonlySet<string>): number => {
    const cached = done.get(id);
    if (cached !== undefined) return cached;
    const open = new Set(path).add(id);
    const depth = Math.max(-1, ...(sources.get(id) ?? []).filter((from) => sources.has(from) && !open.has(from)).map((from) => visit(from, open))) + 1;
    done.set(id, depth);
    return depth;
  };
  for (const node of map.nodes) visit(node.id, new Set());
  return done;
}

const centre = (node: PlacedNode): number => node.y + node.height / 2;

/** The order classes take inside one depth: the reasoning first, then the organisation of the work, then what is told. */
const CLASS_ORDER = ["Plan", "Hypothesis", "Observation", "Decision", "Finding", "Roadmap", "Todo", "Milestone", "Report", "Literature"];
const MAX_ROWS = 6;
const rank = (node: MapNode): number => { const at = CLASS_ORDER.indexOf(node.cls); return at === -1 ? CLASS_ORDER.length : at; };

/**
 * Split the documents of one depth into columns of at most {@link MAX_ROWS}:
 * one class after another, a class starting a new column when it would not
 * fit in what is left of the current one.
 */
function columnsOf(members: readonly MapNode[], weight: (node: MapNode) => number): MapNode[][] {
  const ordered = members.map((node, index) => ({ node, index, weight: weight(node) })).sort((a, b) => rank(a.node) - rank(b.node) || a.weight - b.weight || a.index - b.index).map((entry) => entry.node);
  const columns: MapNode[][] = [[]];
  for (const cls of [...new Set(ordered.map((node) => node.cls))]) {
    const group = ordered.filter((node) => node.cls === cls);
    if (columns.at(-1)!.length > 0 && columns.at(-1)!.length + group.length > MAX_ROWS) columns.push([]);
    for (const node of group) {
      if (columns.at(-1)!.length === MAX_ROWS) columns.push([]);
      columns.at(-1)!.push(node);
    }
  }
  return columns.filter((column) => column.length > 0);
}

export function layoutResearchMap(map: ResearchMap): PlacedNode[] {
  const depth = depths(map);
  const placed = new Map<string, PlacedNode>();
  const depthCount = Math.max(-1, ...depth.values()) + 1;
  let x = 0;
  for (let level = 0; level < depthCount; level += 1) {
    const members = map.nodes.filter((node) => depth.get(node.id) === level);
    const weight = (node: MapNode): number => {
      const ys = map.edges.flatMap((edge) => { const source = edge.from === node.id ? placed.get(edge.to) : undefined; return source === undefined ? [] : [centre(source)]; });
      return ys.length === 0 ? 0 : ys.reduce((sum, value) => sum + value, 0) / ys.length;
    };
    for (const column of columnsOf(members, weight)) {
      const total = column.reduce((sum, node) => sum + MAP_SHAPE_SIZE[shapeOf(node)].height, 0) + Math.max(0, column.length - 1) * ROW_GAP;
      let y = Math.round(-total / 2);
      for (const node of column) {
        const shape = shapeOf(node);
        placed.set(node.id, { id: node.id, shape, x, y, ...MAP_SHAPE_SIZE[shape] });
        y += MAP_SHAPE_SIZE[shape].height + ROW_GAP;
      }
      x += Math.max(...column.map((node) => MAP_SHAPE_SIZE[shapeOf(node)].width)) + COLUMN_GAP;
    }
  }
  return map.nodes.flatMap((node) => { const at = placed.get(node.id); return at === undefined ? [] : [at]; });
}

/**
 * Which references a map may fold away to stay readable, one flag per edge of
 * `map.edges`:
 *
 * - every mention;
 * - every structural reference that a longer chain of structural references
 *   between the same two documents already implies;
 * - when more than {@link MAX_ROWS} documents rest directly on the same one,
 *   the arrows of all but the nearest column of them, which would otherwise
 *   run as one bundle across the columns in between.
 *
 * Nothing is lost: a folded reference is still listed with its document, and
 * drawn when either end is selected.
 */
export function foldedReferences(map: ResearchMap): boolean[] {
  const next = new Map<string, string[]>();
  for (const edge of map.edges) if (STRUCTURAL.has(edge.role)) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  /** Whether `to` is reachable from `from` without using the direct edge between them and without passing back through `from`. */
  const implied = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = (next.get(from) ?? []).filter((id) => id !== to);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(next.get(id) ?? []));
    }
    return false;
  };
  const direct = map.edges.map((edge) => STRUCTURAL.has(edge.role) && !implied(edge.from, edge.to));
  const x = new Map(layoutResearchMap(map).map((node) => [node.id, node.x]));
  const crowd = new Map<string, number[]>();
  map.edges.forEach((edge, index) => { if (direct[index]) crowd.set(edge.to, [...(crowd.get(edge.to) ?? []), x.get(edge.from) ?? 0]); });
  return map.edges.map((edge, index) => {
    if (!direct[index]) return true;
    const sources = crowd.get(edge.to)!;
    return sources.length > MAX_ROWS && (x.get(edge.from) ?? 0) > Math.min(...sources);
  });
}
