/**
 * Runtime-neutral tool specs. Nothing under `tools/` imports DSH: the adapter
 * in `dsh/` turns each spec into a registered DSH tool, and unit tests call
 * `execute` directly with fakes.
 */
import type { ResearchConfig } from "../config.js";
import type { DelegationStore, StoredDelegation } from "../delegation/store.js";
import type { MolabClient } from "../molab/client.js";
import type { ValidationRow } from "../molab/schemas.js";
import type { WorkerLedger } from "../workers.js";

/** What a tool sees of its call. */
export interface ToolExec {
  signal: AbortSignal;
  /** The calling session, recorded as the delegation's supervisor. */
  sessionId?: string;
  /**
   * Who is behind this run (`TACK_BY`, else the OS user): the person whose
   * answers and approvals `research_resume` records. Never the model's choice;
   * absent only when a client (the web UI) names the person itself.
   */
  caller?: string;
  /** A browser action must still refer to the delegation revision the person reviewed. */
  expectedDigest?: string;
  /** A person resumed work outside the agent turn; the existing watcher delivers its next brief. */
  wakeSupervisor?: boolean;
  /** End the current model turn after this result (used by `research_wait`). */
  concludeTurn?: () => void;
  /**
   * The calling session now works on this delegation (used by `research_open`;
   * a call that names its `delegation` focuses the session on it already).
   * Worker starts in the session are charged to it.
   */
  focus?: (delegation: string) => void;
}

/** A tool's value: model-facing text, plus the structured record kept as presentation meta. */
export interface ToolValue {
  text: string;
  meta?: unknown;
}

/** dsh-tools' parameter DSL, kept structural so this layer needs no DSH import. */
export type ParameterSpec = Record<string, Record<string, unknown>>;

export interface ToolSpec<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ParameterSpec;
  execute(args: A, exec: ToolExec): Promise<ToolValue>;
}

/** A registered worker provider, as the runtime describes it. */
export interface WorkerKind {
  name: string;
  /** The provider captures a structured report from an `outputSchema`. */
  structured: boolean;
  /** The provider's children take later messages (`continue`). */
  continuable: boolean;
  /** The worker runs in this process, with the research session's tools. */
  inProcess: boolean;
}

export interface WorkerStartRequest {
  provider: string;
  label: string;
  cwd: string;
  prompt: string;
  /** Requested only from a provider whose kind is `structured`. */
  outputSchema?: Record<string, unknown>;
  /** The supervising session; the runtime needs its live agent as the child's parent. */
  parentSessionId?: string;
  signal: AbortSignal;
}

/** How a worker ended, as its provider reports it. */
export interface WorkerOutcome {
  /** The worker's final text. */
  output: string;
  /** The captured structured report, when an `outputSchema` was requested and satisfied. */
  structured?: unknown;
  stopReason: string;
  diagnostic?: string;
}

/** The runtime's worker port: start a child and hear how it ended; continue one when the provider allows it. */
export interface WorkersPort {
  kinds(): WorkerKind[];
  start(request: WorkerStartRequest): Promise<{ id: string; result: Promise<WorkerOutcome> }>;
  continue?(childId: string, text: string, parentSessionId: string | undefined, signal: AbortSignal): Promise<void>;
}

export interface ResearchDeps {
  config: ResearchConfig;
  molab: MolabClient;
  store: DelegationStore;
  workers: WorkersPort;
  ledger: WorkerLedger;
  logger: { warn(message: string): void };
  /** `molab validate --new-only` over the served workspace: every violation it reports. */
  validate(signal?: AbortSignal): Promise<ValidationRow[]>;
  now(): Date;
  newId(): string;
}

/** Common `delegation` parameter. */
export const DELEGATION_PARAM = {
  delegation: { type: "string", required: true, description: "Workspace-relative path of the Delegation document (from research_open or research_status)." },
} as const;

/** Load a delegation the call names; a clear error when it does not exist. */
export async function loadDelegation(deps: ResearchDeps, path: string, signal?: AbortSignal): Promise<StoredDelegation> {
  if (typeof path !== "string" || path.trim() === "") throw new Error("name the delegation by its document path");
  return deps.store.get(path.trim(), signal);
}

/** Pretty JSON, cut to `limit` characters so one read cannot flood the context. */
export function clipJson(value: unknown, limit = 12_000): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > limit ? JSON.stringify({ truncated: true, preview: text.slice(0, Math.floor(limit / 2)),
    totalCharacters: text.length, hint: "Select a section and page with offset/limit, or narrow projectId/experimentId/runId." }) : text;
}
