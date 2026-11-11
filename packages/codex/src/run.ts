/**
 * One Codex run: spawn `codex app-server --stdio` through the shared
 * subprocess service, publish once the thread exists, settle the turn into a
 * subagent result, and tear the process down.
 *
 * A failure says what Codex said. A refused model, an expired login or a
 * sandbox denial reaches the caller as Codex's own message with its error
 * code and the model in use, not as a fixed category.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentResult,
  type SubagentRun,
} from "@deepseek-ai/dsh-subagent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage.js";
import type { JsonValue } from "./protocol/serde_json/JsonValue.js";
import { CodexAppServer, describeTurnError, errorMessage, type Activity, type PermissionMode, type ThreadOptions, type TurnOutcome } from "./wire.js";

const require = createRequire(import.meta.url);
const codexManifestPath = require.resolve("@openai/codex/package.json");
const codexManifest = JSON.parse(readFileSync(codexManifestPath, "utf8")) as { version: string; bin: { codex: string } };
const ownManifest = JSON.parse(readFileSync(require.resolve("@tack/codex/package.json"), "utf8")) as { version: string };

/** The Codex release this provider runs. */
export const CODEX_VERSION = codexManifest.version;

/** The app-server command: the package-local Codex, independent of `PATH`. */
export function appServerArgv(): string[] {
  return [process.execPath, resolve(dirname(codexManifestPath), codexManifest.bin.codex), "app-server", "--stdio"];
}

/** Bytes of Codex's stderr kept for a startup failure. */
const STDERR_TAIL_BYTES = 2048;

export interface RunSpec extends ThreadOptions {
  env: Record<string, string>;
  disposeGraceMs: number;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
  /** Told once per settled run: how it ended and what it used. */
  report(summary: {
    runId: string;
    task: readonly string[];
    stopReason: SubagentResult["stopReason"];
    model?: string;
    usage?: ThreadTokenUsage;
    diagnostic?: string;
    activity: readonly Activity[];
    /** Enabled hooks Codex skipped because they are not trusted. */
    untrustedHooks: readonly string[];
  }): void;
}

/** The task's text blocks; anything else is refused before a process starts. */
export function taskTexts(prompt: readonly ContentBlock[]): string[] {
  const texts = prompt.map((block) => {
    if (block.type !== "text") throw new Error("codex: the task must contain only text blocks");
    return block.text;
  });
  if (texts.every((text) => text.trim() === "")) throw new Error("codex: the task is empty");
  return texts;
}

/** Turn a finished turn into the subagent result (never throws for a failed turn). */
export function settleTurn(outcome: TurnOutcome, model: string | undefined, declined: readonly string[], wantsStructured: boolean): SubagentResult {
  const output: ContentBlock[] = outcome.answer === undefined ? [] : [{ type: "text", text: outcome.answer }];
  const declinedNote = declined.length === 0 ? "" : `\nDeclined without a human: ${declined.join("; ")}`;
  if (outcome.status !== "completed") {
    const limit = outcome.error?.codexErrorInfo === "contextWindowExceeded";
    const reason = outcome.error === undefined ? `turn ${outcome.status}` : describeTurnError(outcome.error, model);
    return { output, stopReason: limit ? "max-tokens" : "error", diagnostic: `Codex: ${reason}${declinedNote}` };
  }
  if (outcome.answer === undefined) {
    return { output, stopReason: "error", diagnostic: `Codex finished without an answer${model ? ` (model: ${model})` : ""}${declinedNote}` };
  }
  if (!wantsStructured) return declined.length === 0 ? { output, stopReason: "completed" } : { output, stopReason: "completed", diagnostic: declinedNote.trim() };
  try {
    const structured: unknown = JSON.parse(outcome.answer);
    if (structured === null || typeof structured !== "object" || Array.isArray(structured)) throw new Error("not a JSON object");
    return { output, structured, stopReason: "completed" };
  } catch (error) {
    return { output, stopReason: "error", diagnostic: `Codex's answer is not the requested JSON object: ${errorMessage(error)}` };
  }
}

/** Start one run; resolves once Codex has a thread, rejects with Codex's reason otherwise. */
export async function startCodexRun(request: ResolvedSubagentStartRequest, spec: RunSpec): Promise<SubagentRun> {
  const texts = taskTexts(request.prompt);
  request.signal.throwIfAborted();
  const child = spec.spawn({
    argv: appServerArgv(),
    cwd: spec.cwd,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  });
  const { stdout, stdin } = child;
  if (stdout == null || stdin == null) {
    child.terminate();
    throw new Error("codex: app-server started without stdio pipes");
  }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr?.on("error", () => {});
  const server = new CodexAppServer(stdout, stdin, spec.permissionMode);
  const exited = child.done.then((outcome) => {
    throw new Error(`codex: app-server exited (code ${outcome.exitCode ?? "none"}, signal ${outcome.signal ?? "none"})`);
  });
  exited.catch(() => {});
  const teardown = async (): Promise<void> => {
    server.close();
    try {
      child.stdin?.end();
    } catch {
      // The pipe may already be closed by the child.
    }
    child.terminate();
    await child.waitForExit();
    await child.done.catch(() => {});
  };

  try {
    await Promise.race([server.initialize(ownManifest.version, request.signal), exited]);
    await Promise.race([server.startThread(spec, request.signal), exited]);
  } catch (error) {
    await teardown().catch(() => {});
    request.signal.throwIfAborted();
    const tail = stderr.trim();
    throw new Error(`codex ${CODEX_VERSION} could not start a thread: ${errorMessage(error)}${tail ? `\n${tail}` : ""}`, { cause: error });
  }

  // Listing hooks is diagnosis only: a Codex without the method still runs.
  const untrustedHooks = await server.untrustedHooks(request.signal).catch(() => [] as string[]);

  const cancel = new AbortController();
  const requestCancel = (): void => {
    if (cancel.signal.aborted) return;
    cancel.abort(new Error("codex: run cancelled"));
    server.interrupt();
  };
  const onAbort = (): void => requestCancel();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const wantsStructured = request.outputSchema !== undefined;
  const runId = brandString<SessionId>(randomUUID());
  let usage: ThreadTokenUsage | undefined;
  let diagnostic: string | undefined;

  const result = settleRunResult({
    attempt: async () => {
      try {
        const outcome = await Promise.race([
          server.runTurn(
            texts,
            {
              ...(spec.effort !== undefined && { effort: spec.effort }),
              ...(wantsStructured && { outputSchema: request.outputSchema as unknown as JsonValue }),
            },
            cancel.signal,
          ),
          exited,
        ]);
        usage = outcome.usage;
        const settled = settleTurn(outcome, server.model, server.declinedRequests(), wantsStructured);
        diagnostic = settled.diagnostic;
        return settled;
      } catch (error) {
        diagnostic = `Codex: ${errorMessage(error)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`;
        throw error;
      }
    },
    collectOutput: () => server.answerSoFar(),
    collectDiagnostic: () => diagnostic,
    cancelled: () => cancel.signal.aborted,
    signal: request.signal,
    onAbort,
  }).then((settled) => {
    spec.report({
      runId,
      task: texts,
      activity: server.activityLog(),
      untrustedHooks,
      stopReason: settled.stopReason,
      ...(server.model !== undefined && { model: server.model }),
      ...(usage !== undefined && { usage }),
      ...(settled.diagnostic !== undefined && { diagnostic: settled.diagnostic }),
    });
    return settled;
  });

  return subprocessRunHandle({ id: runId, result, signal: request.signal, onAbort, requestCancel, teardown });
}
