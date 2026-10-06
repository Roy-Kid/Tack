/**
 * The delegate card's view model: what one `delegate` call shows in the
 * browser, derived from the call's arguments, its persisted record (the
 * result `meta`), and the nested sub-calls the runtime mirrored. Pure, so the
 * browser half stays a thin renderer.
 */
import type { DelegationRecord } from "./record.js";

export type CardState = "preparing" | "running" | "completed" | "partial" | "failed" | "cancelled" | "error";

/** The parts of the runtime's tool-call block the card reads. */
export interface CallBlock {
  argsRaw?: string;
  meta?: unknown;
  content?: unknown;
  isError?: boolean;
  error?: { name?: string; message?: string; code?: string } | null;
  subCalls?: readonly unknown[];
}

export interface CardModel {
  state: CardState;
  agent: string;
  description: string;
  /** One line for the collapsed row. */
  headline: string;
  /** Full summary or failure text for the expanded body. */
  detail?: string;
  filesChanged: string[];
  commands: { command: string; exitCode: number }[];
  tests?: { command: string; passed: boolean; details?: string };
  followUps: string[];
  /** "3 tool calls · $0.04 · 5 turns" */
  footer?: string;
  /** Whether there is anything to expand. */
  expandable: boolean;
}

function parseArgs(raw: string | undefined): { agent?: string; description?: string } {
  if (raw === undefined) return {};
  try {
    const value = JSON.parse(raw) as { agent?: unknown; description?: unknown };
    return {
      ...(typeof value.agent === "string" && { agent: value.agent }),
      ...(typeof value.description === "string" && { description: value.description }),
    };
  } catch {
    return {};
  }
}

function asRecord(meta: unknown): DelegationRecord | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const record = meta as Partial<DelegationRecord>;
  return typeof record.status === "string" && typeof record.summary === "string" && typeof record.agent === "string" ? (record as DelegationRecord) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export function formatFooter(record: Pick<DelegationRecord, "toolCalls" | "costUsd" | "turns">): string {
  const parts = [`${record.toolCalls} tool call${record.toolCalls === 1 ? "" : "s"}`];
  if (record.costUsd !== undefined) parts.push(`$${record.costUsd < 0.01 && record.costUsd > 0 ? record.costUsd.toFixed(4) : record.costUsd.toFixed(2)}`);
  if (record.turns !== undefined) parts.push(`${record.turns} turn${record.turns === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function cardModel(phase: "preparing" | "start" | "result", block: CallBlock): CardModel {
  const args = parseArgs(block.argsRaw);
  const record = phase === "result" ? asRecord(block.meta) : undefined;
  const agent = record?.agent ?? args.agent ?? "agent";
  const description = args.description ?? "";
  const steps = block.subCalls?.length ?? 0;
  const base = { agent, description, filesChanged: [], commands: [], followUps: [], expandable: false };

  if (phase === "preparing") return { ...base, state: "preparing", headline: "Preparing a delegation" };
  if (phase === "start") {
    return { ...base, state: "running", headline: [description, steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : "starting"].filter(Boolean).join(" · ") };
  }
  if (record === undefined) {
    const text = block.error?.message ?? contentText(block.content);
    const cancelled = block.error?.code === "interrupted" || /cancelled/i.test(text);
    return {
      ...base,
      state: cancelled ? "cancelled" : "error",
      headline: firstLine(text) || (cancelled ? "Cancelled" : "The delegation failed"),
      ...(text.trim() !== "" && { detail: text.trim() }),
      expandable: text.trim().includes("\n"),
    };
  }
  const report = record.report;
  const detail = [record.summary, record.status !== "completed" ? record.diagnostic : undefined].filter((part): part is string => !!part).join("\n\n");
  return {
    state: record.status,
    agent,
    description,
    headline: firstLine(record.summary) || record.status,
    detail,
    filesChanged: record.filesChanged,
    commands: report?.commands ?? [],
    ...(report?.tests !== undefined && { tests: report.tests }),
    followUps: report?.followUps ?? [],
    footer: formatFooter(record),
    expandable: true,
  };
}
