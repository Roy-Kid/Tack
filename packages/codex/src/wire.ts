/**
 * One Codex app-server connection carrying one ephemeral thread and one turn.
 *
 * Every shape on this wire comes from `src/protocol/`, generated from the
 * installed Codex by `scripts/protocol.mjs`, so a Codex upgrade that changes
 * the protocol surfaces here as a type error rather than a runtime surprise.
 * The shared JSON-RPC line transport owns framing and correlation; this module
 * owns the product methods, the unattended answers to server requests, and
 * what a finished turn means.
 */
import type { Readable, Writable } from "node:stream";
import { JsonRpcLineTransport, JsonRpcResponseError } from "@deepseek-ai/dsh-sdk-protocol";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { HooksListParams } from "./protocol/v2/HooksListParams.js";
import type { HooksListResponse } from "./protocol/v2/HooksListResponse.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { ServerRequest } from "./protocol/ServerRequest.js";
import type { ApplyPatchApprovalResponse } from "./protocol/ApplyPatchApprovalResponse.js";
import type { ExecCommandApprovalResponse } from "./protocol/ExecCommandApprovalResponse.js";
import type { CommandExecutionRequestApprovalResponse } from "./protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.js";
import type { ErrorNotification } from "./protocol/v2/ErrorNotification.js";
import type { FileChangeRequestApprovalResponse } from "./protocol/v2/FileChangeRequestApprovalResponse.js";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.js";
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse.js";
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.js";
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage.js";
import type { ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification.js";
import type { ToolRequestUserInputResponse } from "./protocol/v2/ToolRequestUserInputResponse.js";
import type { Turn } from "./protocol/v2/Turn.js";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.js";
import type { TurnError } from "./protocol/v2/TurnError.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.js";
import type { JsonValue } from "./protocol/serde_json/JsonValue.js";

/** Unattended permission modes, each a fixed set of `thread/start` fields. */
export const PERMISSION_MODES = {
  /** Codex never asks; its configured sandbox applies (read-only unless configured otherwise). */
  never: { approvalPolicy: "never" },
  /** Writes inside the working directory; escalations go to Codex's own auto-reviewer. */
  "approve-for-me": { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" },
  /** No sandbox, no approvals. */
  "dangerously-bypass-approvals-and-sandbox": { approvalPolicy: "never", sandbox: "danger-full-access" },
} as const satisfies Record<string, Pick<ThreadStartParams, "approvalPolicy" | "approvalsReviewer" | "sandbox">>;

export type PermissionMode = keyof typeof PERMISSION_MODES;

/** What the thread runs with: Codex settings fill whatever is omitted. */
export interface ThreadOptions {
  cwd: string;
  /** An ephemeral thread is not persisted by Codex; a persisted one lands in Codex's session store. */
  ephemeral: boolean;
  model?: string;
  effort?: TurnStartParams["effort"];
  permissionMode: PermissionMode;
}

/** One thing Codex did in the workspace, for the run's activity log. */
export type Activity =
  | { kind: "command"; command: string; cwd: string; status: string; exitCode: number | null }
  | { kind: "file"; path: string; change: string; status: string };

/** How a turn ended, with everything a diagnostic needs. */
export interface TurnOutcome {
  status: Turn["status"];
  /** The final answer, else the latest partial one, else the latest unphased message. */
  answer?: string;
  error?: TurnError;
  usage?: ThreadTokenUsage;
}

/** The answer to each server request an unattended run can receive. */
type Answer =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse
  | ToolRequestUserInputResponse
  | McpServerElicitationRequestResponse
  | DynamicToolCallResponse
  | ApplyPatchApprovalResponse
  | ExecCommandApprovalResponse;

/** A turn-level error message, its Codex error code, and the model, in one line. */
export function describeTurnError(error: TurnError, model: string | undefined): string {
  const info = error.codexErrorInfo;
  const code = info === null ? undefined : typeof info === "string" ? info : Object.keys(info)[0];
  const facts = [code && `code: ${code}`, model && `model: ${model}`].filter(Boolean).join("; ");
  const details = error.additionalDetails ? ` — ${error.additionalDetails}` : "";
  return `${error.message}${details}${facts ? ` (${facts})` : ""}`;
}

/** The message of a JSON-RPC error response, else of any error. */
export function errorMessage(error: unknown): string {
  if (error instanceof JsonRpcResponseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export class CodexAppServer {
  private readonly transport: JsonRpcLineTransport;
  private readonly declined: string[] = [];
  private threadId?: string;
  private turnId?: string;
  /** Notifications for a turn whose id `turn/start` has not returned yet. */
  private readonly early: { method: string; params: Record<string, unknown> }[] = [];
  private turnDone?: PromiseWithResolvers<Turn>;
  private finalAnswer?: string;
  private partialAnswer?: string;
  private unphasedAnswer?: string;
  private lastError?: TurnError;
  private usage?: ThreadTokenUsage;
  private readonly activity: Activity[] = [];
  /** The model Codex actually runs, from `thread/start`. */
  model?: string;

  constructor(
    stdout: Readable,
    stdin: Writable,
    private readonly permissionMode: PermissionMode,
  ) {
    this.transport = new JsonRpcLineTransport(stdout, stdin);
    this.transport.onRequest((method, params) => Promise.resolve(this.answer(method, params)));
    this.transport.onNotification((method, params) => this.observe(method, params));
  }

  /** The `initialize` / `initialized` handshake. */
  async initialize(version: string, signal: AbortSignal): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: { name: "tack", title: "Tack", version },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    this.transport.start();
    const response = (await this.transport.request("initialize", params, signal)) as InitializeResponse;
    this.transport.notify("initialized");
    await this.transport.flush();
    return response;
  }

  /** Create the run's thread. */
  async startThread(options: ThreadOptions, signal: AbortSignal): Promise<void> {
    const params: ThreadStartParams = {
      cwd: options.cwd,
      ephemeral: options.ephemeral,
      ...(options.model !== undefined && { model: options.model }),
      ...PERMISSION_MODES[options.permissionMode],
    };
    const response = (await this.transport.request("thread/start", params, signal)) as ThreadStartResponse;
    if (response.thread.ephemeral !== options.ephemeral) {
      throw new Error(`codex: app-server created a ${response.thread.ephemeral ? "ephemeral" : "persisted"} thread; asked for the other`);
    }
    this.threadId = response.thread.id;
    this.model = response.model;
  }

  /**
   * Enabled hooks this thread will skip because no person has trusted them.
   * Codex never asks for trust in an unattended run, so a guard hook that is
   * not trusted is skipped without a word; this makes that visible.
   */
  async untrustedHooks(signal: AbortSignal): Promise<string[]> {
    const params: HooksListParams = { threadId: this.requireThread() };
    const response = (await this.transport.request("hooks/list", params, signal)) as HooksListResponse;
    return response.data.flatMap((entry) =>
      entry.hooks.filter((hook) => hook.enabled && (hook.trustStatus === "untrusted" || hook.trustStatus === "modified")).map((hook) => `${hook.key} (${hook.trustStatus})`),
    );
  }

  /** Submit the task and wait for this turn's terminal notification. */
  async runTurn(
    texts: readonly string[],
    options: { effort?: TurnStartParams["effort"]; outputSchema?: JsonValue },
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    const threadId = this.requireThread();
    this.turnDone = Promise.withResolvers<Turn>();
    const params: TurnStartParams = {
      threadId,
      input: texts.map((text) => ({ type: "text", text, text_elements: [] })),
      ...(options.effort !== undefined && { effort: options.effort }),
      ...(options.outputSchema !== undefined && { outputSchema: options.outputSchema }),
    };
    const started = (await this.transport.request("turn/start", params, signal)) as TurnStartResponse;
    this.turnId = started.turn.id;
    for (const { method, params: early } of this.early.splice(0)) this.observe(method, early);
    const turn = await raceAbort(this.turnDone.promise, signal);
    const answer = this.finalAnswer ?? this.partialAnswer ?? this.unphasedAnswer;
    const error = turn.error ?? (turn.status === "completed" ? undefined : this.lastError);
    return {
      status: turn.status,
      ...(answer !== undefined && answer.trim() !== "" && { answer }),
      ...(error != null && { error }),
      ...(this.usage !== undefined && { usage: this.usage }),
    };
  }

  /** The best answer observed so far, as content (for a cancelled or failed run). */
  answerSoFar(): { type: "text"; text: string }[] {
    const answer = this.finalAnswer ?? this.partialAnswer ?? this.unphasedAnswer;
    return answer === undefined || answer.trim() === "" ? [] : [{ type: "text", text: answer }];
  }

  /** Commands Codex ran and files it changed, in order. */
  activityLog(): readonly Activity[] {
    return this.activity;
  }

  /** Requests Codex made that this unattended run declined, for the diagnostic. */
  declinedRequests(): readonly string[] {
    return this.declined;
  }

  /** Best-effort remote cancellation; process teardown stays authoritative. */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined) return;
    this.transport.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  close(): void {
    this.transport.close();
  }

  private requireThread(): string {
    if (this.threadId === undefined) throw new Error("codex: no thread; call startThread first");
    return this.threadId;
  }

  /** Answer a server request without a human: decline anything that needs one. */
  private answer(method: string, params: Record<string, unknown>): Answer {
    const request = { method, params } as ServerRequest;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        this.declined.push(`command: ${request.params.command ?? "(unnamed)"}`);
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        this.declined.push("file change");
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        this.declined.push("additional permissions");
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        this.declined.push("user input");
        return { answers: {} };
      case "mcpServer/elicitation/request":
        this.declined.push(`MCP input (${request.params.serverName})`);
        return { action: "decline", content: null, _meta: null };
      case "item/tool/call":
        this.declined.push(`client tool ${request.params.tool}`);
        return { contentItems: [{ type: "inputText", text: "This client provides no tools." }], success: false };
      case "applyPatchApproval":
        this.declined.push("patch");
        return { decision: "abort" };
      case "execCommandApproval":
        this.declined.push(`command: ${request.params.command.join(" ")}`);
        return { decision: "abort" };
      default:
        throw new Error(`codex: unsupported app-server request ${JSON.stringify(method)}`);
    }
  }

  private observe(method: string, params: Record<string, unknown>): void {
    if (params.threadId !== undefined && params.threadId !== this.threadId) return;
    const turnId = typeof params.turnId === "string" ? params.turnId : turnOf(method, params);
    if (turnId !== undefined && this.turnDone !== undefined && this.turnId === undefined) {
      this.early.push({ method, params });
      return;
    }
    if (turnId !== undefined && turnId !== this.turnId) return;
    switch (method) {
      case "item/completed":
        this.recordItem(params as ItemCompletedNotification);
        return;
      case "error": {
        const notice = params as ErrorNotification;
        if (!notice.willRetry) this.lastError = notice.error;
        return;
      }
      case "thread/tokenUsage/updated":
        this.usage = (params as ThreadTokenUsageUpdatedNotification).tokenUsage;
        return;
      case "turn/completed":
        this.turnDone?.resolve((params as TurnCompletedNotification).turn);
        return;
      default:
        return;
    }
  }

  private recordItem({ item }: ItemCompletedNotification): void {
    if (item.type === "commandExecution") {
      this.activity.push({ kind: "command", command: item.command, cwd: String(item.cwd), status: item.status, exitCode: item.exitCode });
      return;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes) {
        this.activity.push({ kind: "file", path: change.path, change: change.kind.type, status: item.status });
      }
      return;
    }
    if (item.type !== "agentMessage") return;
    if (item.phase === "final_answer") this.finalAnswer = item.text;
    else if (item.phase === "partial_answer") this.partialAnswer = item.text;
    else if (item.phase === null) this.unphasedAnswer = item.text;
  }
}

/** The turn id a `turn/*` notification carries inside its `turn`. */
function turnOf(method: string, params: Record<string, unknown>): string | undefined {
  if (!method.startsWith("turn/")) return undefined;
  const turn = params.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(signal.reason instanceof Error ? signal.reason : new Error("codex: aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
