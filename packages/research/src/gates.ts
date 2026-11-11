/**
 * The human gates as the runtime enforces them, beyond the record (see
 * `delegation/model.ts` for approvals themselves): which gate a config has
 * on, what a worker's call would execute before the dry run is approved,
 * and the trailer a headless run prints about a delegation blocked on a
 * person. Pure: the DSH hooks in `dsh/adapter.ts` ask these.
 */
import type { GatesConfig } from "./config.js";
import { type DelegationRecord, type Gate, parseGate, pendingGate } from "./delegation/model.js";

export const GATE_DRYRUN = { name: "TackGateDryRun", code: "TACK_GATE_DRYRUN" };

const CONFIG_KEY: Readonly<Record<Gate, keyof GatesConfig>> = { parameters: "parameters", plan: "plan", dry_run: "dryRun", results: "results" };

/** Whether a config keeps this gate on. */
export function gateOn(gates: GatesConfig, gate: Gate): boolean {
  return gates[CONFIG_KEY[gate]];
}

/**
 * Whether any dry run of the delegation was approved. A worker's shell command
 * does not say which workflow it runs, so the worker hooks open on the
 * delegation's first dry_run approval; the tools check the target.
 */
export function dryRunOpen(record: DelegationRecord): boolean {
  return record.approvals.some((approval) => approval.gate === "dry_run");
}

/** Pipeline and list operators, command substitution: each piece has its own command (as `confine.ts` splits). */
const SEGMENT = /&&|\|\||[;|&\n]|\$\(|`/;

/**
 * Whether a shell command runs `molab run …` in any of its segments,
 * whatever precedes the `molab` word (`uv run molab run x.py` counts) and
 * whatever follows (`molab run --dry-run` still creates run records). The
 * preview is `molab workflow dry-run …`, which is not `molab run`.
 */
export function runsMolab(command: string): boolean {
  return command.split(SEGMENT).some((segment) => {
    const words = segment.trim().split(/\s+/);
    return words.some((word, index) => (word === "molab" || word.endsWith("/molab")) && words[index + 1] === "run");
  });
}

const EXECUTION_TOOL = "molab_start_execution";
const SHELL_TOOL = "bash";

/** What a worker's call would execute: the execution tool, or the shell command; undefined when nothing executes. */
export function executionOf(tool: string, args: unknown): string | undefined {
  if (tool === EXECUTION_TOOL) return EXECUTION_TOOL;
  if (tool !== SHELL_TOOL || typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && runsMolab(command) ? command : undefined;
}

/** Why a worker's execution was refused before the dry run was approved. */
export function dryRunRefusal(what: string, delegation: string): string {
  return (
    `Not run: ${what} would execute (or create run records) before a person approved the dry run (gate dry_run of delegation ${delegation}). ` +
    "This round is a draft: write or extend the workflow, preview it with `molab workflow dry-run <script.py> --json` (or molab_dry_run; not `molab run --dry-run`, which creates runs), " +
    "and report the dry-run JSON (waves, branches, runs) as a product of kind dry_run. The supervisor asks the person; execution comes in a later round."
  );
}

/** What a headless run prints after its answer about a delegation blocked on a person. */
export interface GateTrailer {
  delegation: string;
  state: string;
  gate?: Gate;
  target?: string;
  questions: string[];
}

export function gateTrailer(path: string, record: DelegationRecord): GateTrailer | undefined {
  if (record.state !== "blocked") return undefined;
  const gate = pendingGate(record);
  return {
    delegation: path,
    state: record.state,
    ...(gate !== undefined && { gate: gate.gate, target: gate.target }),
    questions: record.questions.map((question) => parseGate(question)?.question ?? question),
  };
}

export const TRAILER_LINE = "TACK-GATE";

/** The trailer as printed: the marker line, then the JSON object on one line. */
export function renderTrailer(trailer: GateTrailer): string {
  return `${TRAILER_LINE}\n${JSON.stringify(trailer)}\n`;
}
