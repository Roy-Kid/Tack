/**
 * `tack run`'s command-line provider. Parses the task and options Tack
 * forwards to the one-shot app and publishes them as the `headlessStartup`
 * service the runtime's one-shot runner injects.
 */
import { Command, CommanderError } from "commander";
import { parseAppArgs, processIo, type AppContext, type ProcessIo } from "./cmdline.js";

export const name = "tack-headless-startup";
export const inject = ["cmdlineArgs", "appExit"];
export const HEADLESS_STARTUP_SERVICE = "headlessStartup";

export interface HeadlessStartup {
  task: string | undefined;
  sessionId: string | undefined;
  json: boolean;
}

export function headlessCommand(): Command {
  return new Command()
    .name("tack run")
    .description("Answer one task and exit; the answer goes to stdout and diagnostics to stderr.")
    .helpOption("-h, --help", "show this help")
    .option("--json", "write newline-delimited run events to stdout instead of the final message")
    .option("--session-id <id>", "continue the saved session with this id; an unknown id is an error")
    .argument("[task...]", "the task text; multiple words are joined by spaces, and `-` reads stdin")
    .addHelpText(
      "after",
      `
Examples:
  tack run "run the tests"                  answer one task and exit
  echo "run the tests" | tack run -         read the task from stdin
  tack run --json "run the tests"           emit machine-readable run events
  tack run --session-id <id> "continue"     continue a saved session
`,
    );
}

/** Whether `--json` is a real flag of this invocation (stops at `--`, skips the session id value). */
export function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") return false;
    if (argument === "--json") return true;
    if (argument === "--session-id") index += 1;
  }
  return false;
}

const TASK_REQUIRED = 'error: a task is required, for example: tack run "run the tests"';

export function apply(ctx: AppContext, _config?: unknown, io: ProcessIo = processIo): void {
  const program = headlessCommand();
  if (jsonRequested(ctx.get("cmdlineArgs")?.get() ?? [])) {
    // Keep the stream machine-readable: usage errors become one JSON error event.
    program.error = (message: string, options?: { code?: string; exitCode?: number }): never => {
      io.stdout.write(`${JSON.stringify({ type: "error", message: message.replace(/^error: /, "") })}\n`);
      throw new CommanderError(options?.exitCode ?? 1, options?.code ?? "commander.error", message);
    };
  }
  program.action(() => {
    if (program.args.length > 1 && program.args.includes("-")) program.error("error: `-` must be the only task argument");
    const joined = program.args.join(" ");
    if (program.args.length > 0 && joined.trim() === "") program.error(TASK_REQUIRED);
    const task = program.args.length === 0 ? undefined : joined;
    if (task === undefined && io.stdinIsTty()) program.error(TASK_REQUIRED);
    const options = program.opts<{ json?: boolean; sessionId?: string }>();
    if (options.sessionId !== undefined && options.sessionId.trim() === "") program.error("error: --session-id requires a non-empty session id");
    const startup: HeadlessStartup = { task, sessionId: options.sessionId, json: options.json === true };
    ctx.provide(HEADLESS_STARTUP_SERVICE, startup);
  });
  parseAppArgs(ctx, program, io);
}
