/**
 * The `tack` command line. Parsing is pure: argv in, one Invocation out.
 *
 * `run` and `web` parse only what Tack owns (`--profile`, `--patch`) and hand
 * everything after their own flags to the booted app verbatim. Tack flags
 * therefore come first: the first token these commands do not recognise
 * starts the app's arguments, so `tack run --profile x --json hi` boots
 * profile x with app args `--json hi`, and `tack web --help` prints the web
 * app's help rather than Tack's.
 */
import { Command, CommanderError, InvalidArgumentError } from "commander";

export type Invocation =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "doctor"; profile: string; dumpConfig: boolean }
  | { mode: "run"; profile: string; patches: string[]; args: string[] }
  | { mode: "web"; profile: string; patches: string[]; args: string[] };

export const DEFAULT_RUN_PROFILE = "default";
export const DEFAULT_WEB_PROFILE = "web";

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function selectProfile(value: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError("select a profile only once");
  if (value === "") throw new InvalidArgumentError("--profile needs a name");
  return value;
}

const HELP_AFTER = `
Tack flags (--profile, --patch) come first; the first unrecognised token starts
the app's own arguments, which are forwarded verbatim.

Examples:
  tack run "run the tests"            answer one task, print the result, exit
  echo "task" | tack run -            read the task from stdin
  tack run --help                     the task runner's own flags
  tack web                            serve the browser UI
  tack web --port 0 --no-open         let the OS pick a port, do not open a browser
  tack doctor                         report runtime, home, and profile state
  tack doctor --dump-config           print the composed default profile
`;

/** Build the commander program. `resolved` receives the parsed invocation. */
export function buildProgram(resolve: (invocation: Invocation) => void): Command {
  const program = new Command()
    .name("tack")
    .description("Tack: a general-purpose agent harness.")
    .usage("<command> [options]")
    .option("-V, --version", "print Tack and runtime versions")
    .addHelpText("after", HELP_AFTER)
    .exitOverride()
    .enablePositionalOptions()
    .action((options: { version?: boolean }) => {
      resolve(options.version ? { mode: "version" } : { mode: "help" });
    });

  program.command("version").description("print Tack and runtime versions").action(() => resolve({ mode: "version" }));

  const appCommand = (name: string, description: string, defaultProfile: string, mode: "run" | "web") =>
    program
      .command(name)
      .description(description)
      .helpOption(false)
      .allowUnknownOption()
      .passThroughOptions()
      .argument("[args...]", "arguments for the app (see: tack " + name + " --help)")
      .option("--profile <name>", `Tack profile to boot (default: ${defaultProfile})`, selectProfile)
      .option("--patch <path>", "extra patch overlay applied after the profile layer (repeatable)", collect)
      .action((args: string[], options: { profile?: string; patch?: string[] }) => {
        resolve({ mode, profile: options.profile ?? defaultProfile, patches: options.patch ?? [], args });
      });

  appCommand("run", "answer one task and exit", DEFAULT_RUN_PROFILE, "run");
  appCommand("web", "serve the browser UI", DEFAULT_WEB_PROFILE, "web");

  program
    .command("doctor")
    .description("report runtime, home, and profile state")
    .option("--profile <name>", "profile to check", selectProfile)
    .option("--dump-config", "print the composed profile configuration and exit")
    .action((options: { profile?: string; dumpConfig?: boolean }) => {
      resolve({ mode: "doctor", profile: options.profile ?? DEFAULT_RUN_PROFILE, dumpConfig: options.dumpConfig === true });
    });

  return program;
}

/** Tack's own help text. */
export function helpText(): string {
  return buildProgram(() => {}).helpInformation();
}

/**
 * Parse argv into one invocation.
 * @param argv - arguments after the Node binary and script.
 * @returns the invocation.
 * @throws {CommanderError} for usage errors, and for `-h`/`--help` at the top level
 * (exit code 0, `code: "commander.helpDisplayed"`) after the help was written.
 */
export function parseTackArgs(argv: readonly string[]): Invocation {
  let resolved: Invocation | undefined;
  const program = buildProgram((invocation) => {
    resolved = invocation;
  });
  program.parse([...argv], { from: "user" });
  if (resolved === undefined) throw new CommanderError(1, "tack.unresolved", "tack: no invocation resolved");
  return resolved;
}
