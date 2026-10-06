/**
 * Permission tiers for a delegated Claude run, decided per tool request.
 * Pure: no SDK or host types, so the policy is testable on its own.
 */
import { isAbsolute, relative, resolve } from "node:path";

export type PermissionTier = "read-only" | "edit" | "full";
export type Decision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string };

/** Tools that only observe. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "StructuredOutput", "ToolSearch", "Skill"]);
/** Tools that write files; allowed in `edit` only inside the workspace. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Tools a one-shot delegated run never gets: it cannot hold a dialog or outlive its turn. */
export const DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "EnterWorktree",
  "ExitWorktree",
] as const;

function inside(workspace: string, target: unknown): boolean {
  if (typeof target !== "string" || target === "") return false;
  const path = relative(workspace, resolve(workspace, target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function decide(tier: PermissionTier, workspace: string, tool: string, input: Record<string, unknown>): Decision {
  if (READ_TOOLS.has(tool)) return { kind: "allow" };
  if (tier === "full") return { kind: "allow" };
  if (tier === "read-only") return { kind: "deny", reason: `${tool} is not allowed: this delegation is read-only.` };
  if (EDIT_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path;
    return inside(workspace, target)
      ? { kind: "allow" }
      : { kind: "deny", reason: `${tool} outside the workspace is not allowed (${String(target)}).` };
  }
  const detail = tool === "Bash" && typeof input.command === "string" ? `: ${input.command}` : "";
  return { kind: "ask", reason: `Claude wants to run ${tool}${detail}` };
}

/** What a session's sandbox mode makes of the configured tier. */
export interface EffectiveTier {
  tier: PermissionTier;
  /** Grant asks without prompting: the session already allows everything without approval. */
  allowAsks: boolean;
}

/**
 * Cap the configured tier by the delegating session's sandbox mode: a
 * read-only session gets a read-only Claude, and a full-access session (whose
 * own policy never asks) has Claude's asks granted. The cap never raises the
 * configured tier.
 */
export function effectiveTier(configured: PermissionTier, sandboxMode: string | undefined): EffectiveTier {
  if (sandboxMode === "read-only") return { tier: "read-only", allowAsks: false };
  if (sandboxMode === "danger-full-access") return { tier: configured, allowAsks: configured !== "read-only" };
  return { tier: configured, allowAsks: false };
}
