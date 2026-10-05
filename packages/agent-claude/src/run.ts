/**
 * One delegated Claude run: start an Agent SDK query under the host's managed
 * subprocess, decide its tool permissions, publish its activity as run events,
 * and settle it into DSH's `SubagentResult`.
 *
 * The startup and settlement shape follows @deepseek-ai/dsh-subagent-claude-code
 * 0.2.0-rc.2 (MIT); the permission bridge, events, and structured result are Tack's.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { query, type HookCallbackMatcher, type Options, type PermissionResult, type Query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { settleRunResult, subprocessRunHandle, type SubagentResult, type SubagentRun, type SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { EventQueue, EventTranslator, type RunEvent, type SdkMessageLike } from "./events.js";
import { decide, DISALLOWED_TOOLS, type PermissionTier } from "./permissions.js";
import { ManagedProcess, spawnSpec, teardown } from "./process.js";

/** Tools whose successful call changes a file named in its input. */
const FILE_TOOLS: Readonly<Record<string, string>> = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
const DIAGNOSTIC_LIMIT = 4_000;

export interface RunSpec {
  cwd: string;
  model?: string;
  /** Complete child environment (the SDK passes it to the CLI verbatim). */
  env: Record<string, string | undefined>;
  permissions: PermissionTier;
  maxTurns: number;
  maxBudgetUsd?: number;
  disposeGraceMs: number;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
  /** Ask the host to approve one tool use; resolves true only for an explicit grant. */
  approve(toolName: string, reason: string, signal: AbortSignal): Promise<boolean>;
  onError(error: Error, stopReason: string): void;
}

function textTask(prompt: SubagentStartRequest["prompt"]): string {
  const texts = prompt.map((block) => {
    if (block.type !== "text") throw new Error("agent-claude: the task must contain only text");
    return block.text;
  });
  const text = texts.join("");
  if (text.trim() === "") throw new Error("agent-claude: the task is empty");
  return text;
}

function clip(text: string): string {
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT)}…` : text;
}

function workspacePath(cwd: string, target: string): string | undefined {
  const path = relative(cwd, resolve(cwd, target));
  return path === "" || path.startsWith("..") || isAbsolute(path) ? undefined : path;
}

/** The SDK's terminal message, mapped onto DSH's result vocabulary. */
export function settle(message: SDKResultMessage | undefined, wantStructured: boolean): SubagentResult {
  if (message === undefined) return { output: [], stopReason: "error", diagnostic: "Claude ended without a result." };
  const text = message.subtype === "success" ? message.result : "";
  const output = text.trim() === "" ? [] : [{ type: "text" as const, text }];
  const structured = message.subtype === "success" ? message.structured_output : undefined;
  const withStructured = structured === undefined ? {} : { structured };
  if (message.subtype === "success" && !message.is_error) {
    if (message.stop_reason === "refusal") return { output, stopReason: "refusal", ...withStructured };
    if (wantStructured && structured === undefined) {
      return { output, stopReason: "completed", diagnostic: "Claude finished without a structured report." };
    }
    return { output, stopReason: "completed", ...withStructured };
  }
  const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
  const why: Record<string, string> = {
    error_max_turns: "Claude reached its turn limit.",
    error_max_budget_usd: "Claude reached its budget limit.",
    error_max_structured_output_retries: "Claude could not produce a valid structured report.",
    error_during_execution: "Claude failed during execution.",
    success: "Claude ended on an API error.",
  };
  return {
    output,
    stopReason: "error",
    diagnostic: clip([why[message.subtype] ?? `Claude ended with ${message.subtype}.`, detail].filter(Boolean).join(" ")),
    ...withStructured,
  };
}

export async function startRun(request: SubagentStartRequest, spec: RunSpec): Promise<SubagentRun & { events: AsyncIterable<RunEvent> }> {
  const prompt = textTask(request.prompt);
  if (request.signal.aborted) throw new Error("agent-claude: cancelled before start");

  const controller = new AbortController();
  const requestCancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error("agent-claude: run cancelled"));
  };
  const onAbort = () => requestCancel();
  request.signal.addEventListener("abort", onAbort, { once: true });

  const events = new EventQueue<RunEvent>();
  const translator = new EventTranslator();
  const created = new Set<string>();
  const wantStructured = request.outputSchema !== undefined;

  const canUseTool = async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<PermissionResult> => {
    const decision = decide(spec.permissions, spec.cwd, toolName, input);
    if (decision.kind === "allow") return { behavior: "allow", updatedInput: input };
    if (decision.kind === "deny") return { behavior: "deny", message: decision.reason };
    const granted = await spec.approve(toolName, decision.reason, options.signal).catch(() => false);
    return granted ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `Not approved: ${decision.reason}` };
  };

  const hooks: Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> = {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PreToolUse" && FILE_TOOLS[input.tool_name] !== undefined) {
              const target = (input.tool_input as Record<string, unknown> | null)?.[FILE_TOOLS[input.tool_name]!];
              if (typeof target === "string" && !existsSync(resolve(spec.cwd, target))) created.add(input.tool_use_id);
            }
            return { continue: true };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse" && FILE_TOOLS[input.tool_name] !== undefined) {
              const target = (input.tool_input as Record<string, unknown> | null)?.[FILE_TOOLS[input.tool_name]!];
              const path = typeof target === "string" ? workspacePath(spec.cwd, target) : undefined;
              if (path !== undefined) events.push({ type: "file/changed", path, change: created.has(input.tool_use_id) ? "created" : "modified" });
            }
            return { continue: true };
          },
        ],
      },
    ],
  };

  let child: SubprocessHandle | undefined;
  let managed: ManagedProcess | undefined;
  const options: Options = {
    abortController: controller,
    cwd: spec.cwd,
    ...(spec.model !== undefined && { model: spec.model }),
    env: spec.env,
    settingSources: [],
    persistSession: false,
    permissionMode: "default",
    canUseTool,
    hooks,
    disallowedTools: [...DISALLOWED_TOOLS],
    maxTurns: spec.maxTurns,
    ...(spec.maxBudgetUsd !== undefined && { maxBudgetUsd: spec.maxBudgetUsd }),
    ...(wantStructured && { outputFormat: { type: "json_schema", schema: request.outputSchema as unknown as Record<string, unknown> } }),
    onElicitation: () => Promise.resolve({ action: "decline" }),
    onUserDialog: () => Promise.resolve({ behavior: "cancelled" }),
    spawnClaudeCodeProcess: (spawnOptions) => {
      child = spec.spawn(spawnSpec(spawnOptions, spec.disposeGraceMs));
      managed = new ManagedProcess(child);
      return managed;
    },
  } as Options;

  let running: Query;
  try {
    running = query({ prompt, options });
    if (child === undefined) throw new Error("agent-claude: the SDK did not start a managed Claude process");
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    requestCancel();
    events.close();
    if (child !== undefined) await teardown(undefined, child).catch(() => {});
    throw new Error(`agent-claude: Claude could not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const publishedChild: SubprocessHandle = child;
  const processFailed = publishedChild.done.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  );
  processFailed.catch(() => {});

  const consume = async (): Promise<SubagentResult> => {
    let last: SDKResultMessage | undefined;
    for await (const message of running) {
      for (const event of translator.translate(message as SdkMessageLike)) events.push(event);
      if (message.type === "result") last = message;
    }
    if (last === undefined && managed?.outcome !== undefined && managed.outcome.exitCode !== 0) {
      return { output: [], stopReason: "error", diagnostic: `Claude exited (code ${managed.outcome.exitCode ?? managed.outcome.signal}) without a result.` };
    }
    return settle(last, wantStructured);
  };

  const result = settleRunResult({
    attempt: async () => {
      try {
        return await Promise.race([consume(), processFailed]);
      } finally {
        events.close();
      }
    },
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: (error, stopReason) => spec.onError(error, stopReason),
    signal: request.signal,
    onAbort,
  });

  const handle = subprocessRunHandle({
    id: randomUUID() as SubagentRun["id"],
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      events.close();
      await teardown(running, publishedChild);
    },
  });
  return { ...handle, dispose: () => handle.dispose(), events };
}
