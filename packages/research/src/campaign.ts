/**
 * Read the research campaign a workspace already has, whoever wrote it: the
 * Plan (question, scope, constraints), the Roadmap (stages and the experiment
 * each one is), the Todo (work items and their status) and the Milestones
 * (the criterion that closes a stage). Molab owns these classes; Tack only
 * reads them, leniently, so a document it cannot read is listed rather than
 * fatal.
 */
import { z } from "zod";
import type { MolabClient } from "./molab/client.js";
import type { NoteSummary } from "./molab/schemas.js";

const Stage = z.looseObject({
  id: z.string(),
  title: z.string().default(""),
  experiment: z.string().nullish(),
  depends_on: z.array(z.string()).default([]),
});
const Item = z.looseObject({ id: z.string(), title: z.string().default(""), status: z.string().default("open"), stage: z.string().nullish() });

export interface Campaign {
  plans: { path: string; excerpt: string }[];
  roadmaps: { path: string; stages: z.infer<typeof Stage>[] }[];
  todos: { path: string; items: z.infer<typeof Item>[] }[];
  milestones: { path: string; stage: string; criterion: string; status: string }[];
  /** Planning documents whose fields Tack could not read. */
  unreadable: { path: string; error: string }[];
}

export const PLANNING_CLASSES = new Set(["Plan", "Roadmap", "Todo", "Milestone"]);

/** Read every planning document among `docs`. */
export async function readCampaign(molab: MolabClient, docs: readonly NoteSummary[], signal?: AbortSignal): Promise<Campaign> {
  const campaign: Campaign = { plans: [], roadmaps: [], todos: [], milestones: [], unreadable: [] };
  const planning = docs.filter((doc) => PLANNING_CLASSES.has(doc.cls));
  const records = await Promise.allSettled(planning.map((doc) => (doc.cls === "Plan" ? Promise.resolve(undefined) : molab.getRecord(doc.relPath, signal))));
  planning.forEach((doc, index) => {
    const settled = records[index]!;
    if (settled.status === "rejected") {
      campaign.unreadable.push({ path: doc.relPath, error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) });
      return;
    }
    const record = settled.value?.record ?? {};
    const fail = (error: z.ZodError) => campaign.unreadable.push({ path: doc.relPath, error: z.prettifyError(error) });
    switch (doc.cls) {
      case "Plan":
        campaign.plans.push({ path: doc.relPath, excerpt: doc.excerpt.slice(0, 240) });
        break;
      case "Roadmap": {
        const stages = z.array(Stage).safeParse(record.stages ?? []);
        if (stages.success) campaign.roadmaps.push({ path: doc.relPath, stages: stages.data });
        else fail(stages.error);
        break;
      }
      case "Todo": {
        const items = z.array(Item).safeParse(record.items ?? []);
        if (items.success) campaign.todos.push({ path: doc.relPath, items: items.data });
        else fail(items.error);
        break;
      }
      case "Milestone":
        campaign.milestones.push({
          path: doc.relPath,
          stage: String(record.stage ?? "?"),
          criterion: String(record.criterion ?? ""),
          status: String(record.status ?? "open"),
        });
        break;
    }
  });
  return campaign;
}

/** A compact, model-facing account of the campaign. */
export function renderCampaign(campaign: Campaign): string {
  if (campaign.plans.length + campaign.roadmaps.length + campaign.todos.length + campaign.milestones.length === 0) {
    return "No campaign documents (Plan / Roadmap / Todo / Milestone) yet.";
  }
  const lines: string[] = [];
  for (const plan of campaign.plans) lines.push(`Plan ${plan.path}: ${plan.excerpt.replace(/\s+/g, " ").trim()}`);
  for (const roadmap of campaign.roadmaps) {
    lines.push(`Roadmap ${roadmap.path}:`);
    for (const stage of roadmap.stages) {
      const deps = stage.depends_on.length > 0 ? ` after ${stage.depends_on.join(", ")}` : "";
      lines.push(`  - ${stage.id}: ${stage.title}${stage.experiment ? ` → experiment ${stage.experiment}` : ""}${deps}`);
    }
  }
  for (const todo of campaign.todos) {
    const counts = new Map<string, number>();
    for (const item of todo.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    lines.push(`Todo ${todo.path} (${[...counts].map(([status, n]) => `${n} ${status}`).join(", ")}):`);
    for (const item of todo.items) lines.push(`  - [${item.status}] ${item.id}${item.stage ? ` (${item.stage})` : ""}: ${item.title}`);
  }
  for (const milestone of campaign.milestones) lines.push(`Milestone ${milestone.path} [${milestone.status}] closes ${milestone.stage}: ${milestone.criterion}`);
  for (const doc of campaign.unreadable) lines.push(`Unreadable ${doc.path}: ${doc.error}`);
  return lines.join("\n");
}
