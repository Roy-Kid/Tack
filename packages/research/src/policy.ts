/**
 * Authorization: A_child ⊆ A_parent ∩ A_scope.
 *
 * The scope half is enforced by molab itself (`molab serve` opened at a node
 * exposes only that node and its descendants). This module is the
 * delegation half: each tool needs one action, and a delegation may only take
 * the actions it was granted. A worker brief inherits the parent's actions,
 * never more. The scope check here is a fast local refusal for the cases the
 * ref spells out; the server stays the authority.
 */
import type { Action, DelegationRecord } from "./delegation/model.js";

/** The single action each research tool needs. */
export const TOOL_ACTIONS = {
  research_context: "read",
  research_audit: "read",
  research_status: "read",
  molab_read_outputs: "read",
  molab_dry_run: "read",
  molab_create_experiment: "create_experiment",
  molab_create_run: "create_run",
  molab_start_execution: "start_execution",
  molab_cancel_execution: "cancel_execution",
  research_plan: "write_knowledge",
  research_assess: "write_knowledge",
  research_decide: "write_knowledge",
  research_report: "write_knowledge",
  research_retract: "write_knowledge",
  research_wait: "start_execution",
  research_dispatch: "delegate_worker",
} as const satisfies Record<string, Action>;

export type PolicedTool = keyof typeof TOOL_ACTIONS;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Refuse a tool the delegation was not granted. */
export function requireAction(record: DelegationRecord, tool: PolicedTool): void {
  const action = TOOL_ACTIONS[tool];
  if (!record.actions.includes(action)) {
    throw new PolicyError(`${tool} needs the "${action}" action, which this delegation was not granted (granted: ${record.actions.join(", ")})`);
  }
}

/** Refuse a granted action set wider than the parent's. */
export function requireSubset(parent: readonly Action[], requested: readonly Action[]): void {
  const extra = requested.filter((action) => !parent.includes(action));
  if (extra.length > 0) throw new PolicyError(`cannot grant ${extra.join(", ")}: the parent scope does not hold it`);
}

/**
 * Whether `target` (a `molab:` ref) can be inside `scope` (a `molab:` ref).
 * Experiment and run scopes nest by prefix. A project scope cannot be decided
 * from an experiment ref alone (refs omit the project), so it defers to the
 * server unless the target's project is known.
 */
export function withinScope(scope: string, target: string, targetProject?: string | null): boolean {
  if (scope.startsWith("molab:project/")) {
    if (target.startsWith("molab:project/")) return target === scope || target.startsWith(`${scope}/`);
    return targetProject === undefined || targetProject === null || `molab:project/${targetProject}` === scope;
  }
  return target === scope || target.startsWith(`${scope}/`);
}

export function requireWithinScope(scope: string, target: string, targetProject?: string | null): void {
  if (!withinScope(scope, target, targetProject)) throw new PolicyError(`${target} is outside this delegation's scope ${scope}`);
}
