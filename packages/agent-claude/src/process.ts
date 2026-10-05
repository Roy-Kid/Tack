/**
 * The Claude Code CLI process, owned by the host's managed-subprocess service.
 *
 * The SDK keeps its own protocol transport; this module only routes the spawn
 * through `ctx.subprocess` (process-range ownership, termination ladder) and
 * projects the managed handle onto the SDK's `SpawnedProcess` shape.
 *
 * Adapted from @deepseek-ai/dsh-subagent-claude-code 0.2.0-rc.2
 * (lib/types/process.js and the teardown in lib/types/run.js),
 * Copyright (c) DeepSeek, MIT License.
 */
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

type Listener = Parameters<EventEmitter["on"]>[1];
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

const thrown = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/** The SDK's complete child environment as an overlay: names it removed become tombstones. */
function environmentOverlay(env: SpawnOptions["env"]): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(scrubbedParentEnv())) if (!(name in env)) overlay[name] = undefined;
  return overlay;
}

export function spawnSpec(options: SpawnOptions, graceMs: number): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd === "") throw new Error("agent-claude: the SDK spawn request has no working directory");
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    graceMs,
    signal: options.signal,
    env: environmentOverlay(options.env),
  };
}

/** SDK-facing view of one managed process. */
export class ManagedProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly events = new EventEmitter();
  private outcomeValue: SubprocessOutcome | undefined;
  private killRequested = false;

  constructor(private readonly child: SubprocessHandle) {
    if (child.stdin === undefined || child.stdout === undefined) throw new Error("agent-claude: the managed process has no piped stdio");
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.events.on("error", () => {});
    child.done.then(
      (outcome) => {
        this.outcomeValue = outcome;
        this.events.emit("exit", outcome.exitCode, outcome.signal);
      },
      (error: unknown) => this.events.emit("error", thrown(error)),
    );
  }

  get killed(): boolean {
    return this.killRequested;
  }
  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null;
  }
  get outcome(): SubprocessOutcome | undefined {
    return this.outcomeValue;
  }

  /** The managed service owns the signal ladder; the SDK's choice of signal is advisory. */
  kill(): boolean {
    if (this.killRequested || this.outcomeValue !== undefined) return false;
    this.killRequested = true;
    this.child.terminate();
    return true;
  }

  on(event: "exit" | "error", listener: Listener): void {
    this.events.on(event, listener);
  }
  once(event: "exit" | "error", listener: Listener): void {
    this.events.once(event, listener);
  }
  off(event: "exit" | "error", listener: Listener): void {
    this.events.off(event, listener);
  }
}

/** Close the query, terminate the managed range, and wait until it has exited. */
export async function teardown(query: { close(): void } | undefined, child: SubprocessHandle): Promise<void> {
  const failures: Error[] = [];
  try {
    query?.close();
  } catch (error) {
    failures.push(thrown(error));
  }
  child.terminate();
  try {
    await child.waitForExit();
  } catch (error) {
    failures.push(thrown(error));
  }
  await child.done.catch(() => {});
  if (failures.length === 1) throw failures[0]!;
  if (failures.length > 1) throw new AggregateError(failures, "agent-claude: teardown failed");
}
