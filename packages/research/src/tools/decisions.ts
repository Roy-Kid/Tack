/**
 * Decisions and capability gaps.
 *
 * A decision lives in its Delegation's decision log (`decisions` on the
 * record), not in a document of its own. A capability gap about a science
 * tool (molpy, atomiverse, molvis) is one item of the workspace's single
 * `capability-gaps` Todo, merged by component and title, so a gap found ten
 * times is one item that names where it was seen. A gap about the harness
 * itself (molab, DSH, Tack) is not science: it never enters the workspace, it
 * is returned to the supervisor and logged.
 */
import { MolabError } from "../molab/client.js";
import type { CapabilityGap } from "../delegation/report.js";
import { writeCited } from "./records.js";
import type { ResearchDeps } from "./types.js";

export const DECISIONS = ["add_run", "new_experiment", "fix", "continue", "ask_human", "conclude", "stop_route", "stop", "capability_gap"] as const;
export type DecisionKind = (typeof DECISIONS)[number];

/** The components of the harness: a gap in one of these is about Tack and molab, not about the science. */
export const INFRA_COMPONENTS: ReadonlySet<CapabilityGap["component"]> = new Set(["molab", "dsh", "tack"]);

/** The one Todo every science capability gap of the served scope lands in. */
export const GAPS_NAME = "capability-gaps";
export const GAPS_PATH = `knowledges/${GAPS_NAME}.md`;

interface GapEntry {
  id: string;
  component: string;
  title: string;
  repro: string;
  version?: string;
  fix?: string;
  /** The reports and delegations that named it, oldest first. */
  seen_in: string[];
}

interface TodoItem {
  id: string;
  title: string;
  status: string;
  stage?: string;
}

const gapId = (gap: Pick<CapabilityGap, "component" | "title">): string =>
  `${gap.component}-${gap.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Merge `gaps` into the entries already filed: one entry per component and title, the latest repro wins, every citation kept. */
export function mergeGaps(existing: readonly GapEntry[], gaps: readonly CapabilityGap[], seenIn: string): GapEntry[] {
  const merged = new Map(existing.map((entry) => [entry.id, entry]));
  for (const gap of gaps) {
    const id = gapId(gap);
    const prior = merged.get(id);
    merged.set(id, {
      id,
      component: gap.component,
      title: gap.title,
      repro: gap.repro,
      ...((gap.version ?? prior?.version) && { version: (gap.version ?? prior?.version)! }),
      ...((gap.fix ?? prior?.fix) && { fix: (gap.fix ?? prior?.fix)! }),
      seen_in: [...new Set([...(prior?.seen_in ?? []), seenIn])],
    });
  }
  return [...merged.values()];
}

function renderGaps(entries: readonly GapEntry[], items: readonly TodoItem[]): string {
  const status = new Map(items.map((item) => [item.id, item.status]));
  return [
    "# Capability gaps",
    "",
    "Science tools the research found missing or broken, one entry per component and title. Close an item when the tool is fixed.",
    "",
    ...entries.flatMap((entry) => [
      `## ${entry.component}: ${entry.title}`,
      "",
      `- Status: ${status.get(entry.id) ?? "open"}`,
      `- Reproduce: ${entry.repro}`,
      ...(entry.version ? [`- Version: ${entry.version}`] : []),
      ...(entry.fix ? [`- Suggested fix: ${entry.fix}`] : []),
      `- Seen in: ${entry.seen_in.join(", ")}`,
      "",
    ]),
  ].join("\n");
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * File the gaps a report or decision names. Science gaps are merged into the
 * `capability-gaps` Todo (created on first use); harness gaps are only
 * returned and logged.
 */
export async function fileCapabilityGaps(
  deps: ResearchDeps,
  gaps: readonly CapabilityGap[],
  seenIn: string,
  scope: string,
): Promise<{ todo?: string; infra: CapabilityGap[] }> {
  const infra = gaps.filter((gap) => INFRA_COMPONENTS.has(gap.component));
  for (const gap of infra) deps.logger.warn(`tack-research: harness capability gap (${gap.component}): ${gap.title} — ${gap.repro} [${seenIn}]; not written to the workspace`);
  const science = gaps.filter((gap) => !INFRA_COMPONENTS.has(gap.component));
  if (science.length === 0) return { infra };
  let record: Record<string, unknown> = {};
  try {
    record = (await deps.molab.getRecord(GAPS_PATH)).record;
  } catch (error) {
    if (!(error instanceof MolabError && error.status === 404)) throw error;
  }
  const entries = mergeGaps(asArray<GapEntry>(record.gaps), science, seenIn);
  const known = asArray<TodoItem>(record.items);
  const items: TodoItem[] = entries.map((entry) => known.find((item) => item.id === entry.id) ?? { id: entry.id, title: `${entry.component}: ${entry.title}`, status: "open" });
  // Same name, same document: molab rewrites it in place and its history keeps the earlier version.
  const written = await writeCited(deps, { name: GAPS_NAME, cls: "Todo", hostPath: "", body: renderGaps(entries, items), record: { items, gaps: entries } }, [], scope, "cites");
  return { todo: written.relPath, infra };
}
