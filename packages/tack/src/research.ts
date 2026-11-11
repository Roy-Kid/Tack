/**
 * `tack research amend`: a person changes a delegation's terms. The
 * supervisor cannot widen its own budget or authority; it asks
 * (research_decide ask_human), and a person answers here. Every amendment is
 * recorded on the delegation with who, when and why, and molab commits it to
 * the workspace history.
 */
import { ACTIONS, amend, type Action, BUDGET_KEYS, type BudgetKey, DelegationStore, MolabClient } from "@tack/research/store";
import type { ReplayQuery } from "@tack/research/store";

export interface ReplayInvocation {
  mode: "research";
  action: "replay";
  query: Partial<ReplayQuery>;
  json: boolean;
  molabUrl: string;
}

export async function runResearchReplay(invocation: ReplayInvocation, write: (line: string) => void, token = process.env.MOLAB_TOKEN): Promise<number> {
  const client = new MolabClient({ url: invocation.molabUrl, ...(token && { token }) });
  const page = await client.replay(invocation.query);
  if (invocation.json) write(`${JSON.stringify(page, null, 2)}\n`);
  else {
    write(`Research replay · ${page.total} events · oldest first\n`);
    for (const event of page.events) {
      write(`${event.at}  ${event.action}  ${event.title}\n`);
      if (event.ref) write(`  ${event.ref}\n`);
      if (event.details.mode) write(`  ${event.details.mode}${event.details.basedOnExecutionId ? ` ← ${event.details.basedOnExecutionId}` : ""}\n`);
      if (event.document) write(`  ${event.document} @ ${event.commit}\n`);
    }
    for (const warning of page.warnings) write(`${warning}\n`);
    if (page.nextOffset !== null) write(`Next: --offset ${page.nextOffset} --as-of ${page.asOf}\n`);
  }
  return 0;
}

export interface AmendInvocation {
  mode: "research";
  action: "amend";
  delegation: string;
  budget: Partial<Record<BudgetKey, number>>;
  addActions: string[];
  reason: string;
  by: string;
  molabUrl: string;
}

/** Parse `key=value` budget limits; throws on an unknown key or a bad number. */
export function parseBudget(entries: readonly string[]): Partial<Record<BudgetKey, number>> {
  const budget: Partial<Record<BudgetKey, number>> = {};
  for (const entry of entries) {
    const [key, raw] = entry.split("=", 2);
    if (!BUDGET_KEYS.includes(key as BudgetKey)) throw new Error(`unknown budget line "${key}"; one of ${BUDGET_KEYS.join(", ")}`);
    const value = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(value) || value < 0) throw new Error(`budget ${key} needs a non-negative number, got "${raw ?? ""}"`);
    budget[key as BudgetKey] = value;
  }
  return budget;
}

export async function runResearchAmend(invocation: AmendInvocation, write: (line: string) => void, token = process.env.MOLAB_TOKEN): Promise<number> {
  const unknown = invocation.addActions.filter((action) => !(ACTIONS as readonly string[]).includes(action));
  if (unknown.length > 0) throw new Error(`unknown action(s) ${unknown.join(", ")}; one of ${ACTIONS.join(", ")}`);
  if (Object.keys(invocation.budget).length === 0 && invocation.addActions.length === 0) throw new Error("nothing to amend: give --budget key=value and/or --add-action");
  const store = new DelegationStore(new MolabClient({ url: invocation.molabUrl, ...(token !== undefined && token !== "" && { token }) }), invocation.by);
  const stored = await store.update(invocation.delegation, (record) => {
    const changes = {
      ...(Object.keys(invocation.budget).length > 0 && { budget: { ...record.budget, ...invocation.budget } }),
      ...(invocation.addActions.length > 0 && { actions: [...new Set<Action>([...record.actions, ...(invocation.addActions as Action[])])] }),
    };
    return amend(record, { at: new Date().toISOString(), by: invocation.by, reason: invocation.reason, changes }, changes);
  });
  write(`Amended ${stored.path}: budget ${JSON.stringify(stored.record.budget)}, actions ${stored.record.actions.join(", ")} (state ${stored.record.state}).\n`);
  return 0;
}
