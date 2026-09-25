/**
 * Minimal launcher contract the Tack app plugins rely on. The launcher
 * provides these services before any tree entry mounts; they are declared
 * structurally here so Tack plugins import nothing from the runtime.
 */
import { Command, CommanderError } from "commander";

export interface CmdlineArgs {
  get(): readonly string[];
}

export type AppExit = (code: number) => void;

/** The slice of a plugin context these plugins use. */
export interface AppContext {
  get(name: "cmdlineArgs"): CmdlineArgs | undefined;
  get(name: "appExit"): AppExit | undefined;
  provide(name: string, value: unknown): void;
}

export interface ProcessIo {
  stdinIsTty(): boolean | undefined;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export const processIo: ProcessIo = {
  stdinIsTty: () => process.stdin.isTTY,
  stdout: process.stdout,
  stderr: process.stderr,
};

function isCommanderError(error: unknown): error is CommanderError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return typeof candidate.code === "string" && candidate.code.startsWith("commander.") && typeof candidate.exitCode === "number";
}

/**
 * Parse the invocation's app arguments with `program`. Help and usage errors
 * request process exit through the launcher; a successful parse runs the
 * program's action, which publishes the plugin's service.
 */
export function parseAppArgs(ctx: AppContext, program: Command, io: ProcessIo = processIo): void {
  const args = ctx.get("cmdlineArgs");
  const exit = ctx.get("appExit");
  if (args === undefined || exit === undefined) {
    throw new Error(`${program.name()}: the launcher must provide cmdlineArgs and appExit before the tree mounts`);
  }
  program.exitOverride().configureOutput({
    writeOut: (text) => void io.stdout.write(text),
    writeErr: (text) => void io.stderr.write(text),
  });
  try {
    program.parse([...args.get()], { from: "user" });
  } catch (error) {
    if (!isCommanderError(error)) throw error;
    exit(error.exitCode);
  }
}
