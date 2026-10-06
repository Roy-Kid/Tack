/**
 * The persisted shape of one delegation: the `delegate` call's result `meta`,
 * read back by the browser card. Types only, shared by both halves.
 */

export interface DelegationReport {
  status: "completed" | "partial" | "failed";
  summary: string;
  filesChanged: string[];
  commands?: { command: string; exitCode: number }[];
  tests?: { command: string; passed: boolean; details?: string };
  artifacts?: { path: string; description: string }[];
  followUps?: string[];
}

/** The persisted record of one delegation (the call's `meta`; also the tool's canonical value). */
export interface DelegationRecord {
  agent: string;
  runId: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  stopReason: string;
  summary: string;
  report?: DelegationReport;
  /** The child's text answer when it returned no structured report. */
  text?: string;
  diagnostic?: string;
  toolCalls: number;
  filesChanged: string[];
  costUsd?: number;
  turns?: number;
}
