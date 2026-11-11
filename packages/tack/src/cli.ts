/**
 * The `tack` command line. Parsing is pure: argv in, one Invocation out.
 *
 * `run` and `web` parse only what Tack owns (`--profile`, `--patch`) and hand
 * everything after their own flags to the booted app verbatim. Tack flags
 * therefore come first: the first token it does not recognise
 * starts the app's arguments, so `tack run --profile x --json hi` boots
 * profile x with app args `--json hi`, and `tack web --help` prints the
 * web app's own help.
 */
import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { ModelInvocation } from "./models.js";
import type { PluginAction } from "./plugin.js";
import { type AmendInvocation, type ReplayInvocation, parseBudget } from "./research.js";

export type Invocation =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "doctor"; profile: string; dumpConfig: boolean; tools: boolean }
  | { mode: "plugin"; action: PluginAction; profile: string; names: string[] }
  | { mode: "run"; profile: string; patches: string[]; args: string[]; model?: string }
  | { mode: "web"; profile: string; patches: string[]; args: string[] }
  | AmendInvocation
  | ReplayInvocation
  | ModelInvocation;

export const DEFAULT_RUN_PROFILE = "default";
export const DEFAULT_WEB_PROFILE = "web";

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const optionalProfile = (options: { profile?: string }): { profile?: string } =>
  options.profile !== undefined ? { profile: options.profile } : {};

function selectProfile(value: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError("select a profile only once");
  if (value === "") throw new InvalidArgumentError("--profile needs a name");
  return value;
}

const HELP_AFTER = `
Tack flags (--profile, --patch, --model) come first; the
first unrecognised token starts the app's own arguments, which are forwarded
verbatim.

Examples:
  tack run "run the tests"            answer one task, print the result, exit
  echo "task" | tack run -            read the task from stdin
  tack run --help                     the task runner's own flags
  tack web                            serve DeepSeek Harness's web UI
  tack web --port 0 --no-open         let the OS pick a port, do not open a browser
  tack web --help                     the web app's own flags
  tack doctor                         report runtime, home, and profile state
  tack doctor --dump-config           print the composed default profile
  tack doctor --tools                 list the tools registered in the default profile
  tack plugin add <package>           install a plugin into the default profile
  tack plugin list --profile supervise
                                      list the supervisor profile's plugins
  tack model use anthropic/claude-sonnet-4-5
                                      switch the default model in every Tack profile
  tack run --model openai/gpt-5 "task"   use another model for one run
  tack research amend <delegation> --budget worker_runs=10 --reason "..."
                                      widen a research delegation's budget
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

  program
    .command("run")
    .description("answer one task and exit")
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]", "arguments for the app (see: tack run --help)")
    .option("--profile <name>", `Tack profile to boot (default: ${DEFAULT_RUN_PROFILE})`, selectProfile)
    .option("--patch <path>", "extra patch overlay applied after the profile layer (repeatable)", collect)
    .action((args: string[], options: { profile?: string; patch?: string[]; model?: string }) => {
      const base = { mode: "run" as const, profile: options.profile ?? DEFAULT_RUN_PROFILE, patches: options.patch ?? [], args };
      resolve(options.model !== undefined ? { ...base, model: options.model } : base);
    })
    .option(
      "--model <provider/model>",
      "use this model for this run only (saved settings are not changed)",
    );

  program
    .command("web")
    .description("serve DeepSeek Harness's web UI")
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]", "arguments for the web app (see: tack web --help)")
    .option("--profile <name>", `Tack profile to boot (default: ${DEFAULT_WEB_PROFILE})`, selectProfile)
    .option("--patch <path>", "extra patch overlay applied after the profile layer (repeatable)", collect)
    .action((args: string[], options: { profile?: string; patch?: string[] }) => {
      resolve({ mode: "web", profile: options.profile ?? DEFAULT_WEB_PROFILE, patches: options.patch ?? [], args });
    });

  const profileOption = "--profile <name>";
  const profileHelp = "apply to one Tack profile (default: every Tack profile)";
  const model = program.command("model").description("show, list, and switch the default model");
  model
    .command("show", { isDefault: true })
    .description("show the default model of each Tack profile")
    .option(profileOption, "show one Tack profile", selectProfile)
    .action((options: { profile?: string }) => resolve({ mode: "model", action: "show", ...optionalProfile(options) }));
  model
    .command("list")
    .description("list configured providers and their models")
    .option("--provider <id>", "only this provider")
    .option(profileOption, `profile to read (default: ${DEFAULT_RUN_PROFILE})`, selectProfile)
    .action((options: { profile?: string; provider?: string }) =>
      resolve({ mode: "model", action: "list", ...optionalProfile(options), ...(options.provider !== undefined && { provider: options.provider }) }),
    );
  model
    .command("use")
    .description("set the default model, e.g. `tack model use anthropic/claude-sonnet-4-5`")
    .argument("<provider/model>")
    .option(profileOption, profileHelp, selectProfile)
    .action((selection: string, options: { profile?: string }) =>
      resolve({ mode: "model", action: "use", selection, ...optionalProfile(options) }),
    );

  const provider = program.command("provider").description("configure model providers (DeepSeek is built in)");
  provider
    .command("list", { isDefault: true })
    .description("list routable providers in each Tack profile")
    .option(profileOption, "list one Tack profile", selectProfile)
    .action((options: { profile?: string }) => resolve({ mode: "provider", action: "list", ...optionalProfile(options) }));
  provider
    .command("add")
    .description("add a provider route: a built-in catalog (anthropic, openai, google, openrouter, …) or a custom endpoint")
    .argument("<id>")
    .option("--api-key-env <ref>", "credential reference holding the key, e.g. ANTHROPIC_API_KEY")
    .option("--display-name <name>", "name shown in selectors")
    .option("--api <protocol>", "custom endpoint protocol: openai-completions, openai-responses, anthropic-messages")
    .option("--base-url <url>", "custom endpoint base URL")
    .option("--model <id>", "model id offered by a custom endpoint (repeatable)", collect)
    .option(profileOption, profileHelp, selectProfile)
    .action((id: string, options: { apiKeyEnv?: string; displayName?: string; api?: string; baseUrl?: string; model?: string[]; profile?: string }) => {
      const custom = options.api !== undefined || options.baseUrl !== undefined || options.model !== undefined;
      if (custom && (options.api === undefined || options.baseUrl === undefined || options.model === undefined)) {
        throw new InvalidArgumentError("a custom endpoint needs --api, --base-url, and at least one --model");
      }
      if (options.api !== undefined && !["openai-completions", "openai-responses", "anthropic-messages"].includes(options.api)) {
        throw new InvalidArgumentError(`unknown --api "${options.api}"`);
      }
      const route = {
        ...(options.apiKeyEnv !== undefined && { apiKeyEnv: options.apiKeyEnv }),
        ...(options.displayName !== undefined && { displayName: options.displayName }),
        ...(options.api !== undefined && { api: options.api as "openai-completions" | "openai-responses" | "anthropic-messages" }),
        ...(options.baseUrl !== undefined && { baseURL: options.baseUrl }),
        ...(options.model !== undefined && { models: options.model.map((modelId) => ({ id: modelId })) }),
      };
      resolve({ mode: "provider", action: "add", id, route, ...optionalProfile(options) });
    });
  provider
    .command("remove")
    .description("remove a provider route added with `tack provider add`")
    .argument("<id>")
    .option(profileOption, profileHelp, selectProfile)
    .action((id: string, options: { profile?: string }) => resolve({ mode: "provider", action: "remove", id, ...optionalProfile(options) }));

  const auth = program.command("auth").description("store and inspect provider keys (shared by every Tack profile)");
  auth
    .command("set")
    .description("store a key read from stdin, e.g. `printf %s \"$KEY\" | tack auth set ANTHROPIC_API_KEY`")
    .argument("<ref>")
    .action((ref: string) => resolve({ mode: "auth", action: "set", ref }));
  auth
    .command("status", { isDefault: true })
    .description("show which keys are configured (values are never printed)")
    .argument("[ref...]")
    .action((refs: string[] | undefined) => resolve({ mode: "auth", action: "status", refs: refs ?? [] }));

  program
    .command("doctor")
    .description("report runtime, home, and profile state")
    .option("--profile <name>", "profile to check", selectProfile)
    .option("--dump-config", "print the composed profile configuration and exit")
    .option("--tools", "list the tools registered on the profile's host plane (boots without its app) and exit")
    .action((options: { profile?: string; dumpConfig?: boolean; tools?: boolean }) => {
      resolve({
        mode: "doctor",
        profile: options.profile ?? DEFAULT_RUN_PROFILE,
        dumpConfig: options.dumpConfig === true,
        tools: options.tools === true,
      });
    });

  const research = program.command("research").description("inspect research history or act on a delegation");
  research.command("replay")
    .description("replay the recorded research sequence without executing compute")
    .option("--project <id>", "project id")
    .option("--experiment <id>", "experiment id")
    .option("--run <id>", "run id")
    .option("--kind <kind>", "experiment, run, execution, knowledge, asset or history")
    .option("--offset <number>", "event offset", "0")
    .option("--limit <number>", "events per page (1–200)", "50")
    .option("--as-of <time>", "upper timestamp from the previous page")
    .option("--json", "emit the complete structured page", false)
    .option("--molab-url <url>", "molab serve URL", process.env.MOLAB_URL ?? "http://localhost:8000")
    .action((options: { project?: string; experiment?: string; run?: string; kind?: ReplayInvocation["query"]["kind"]; offset: string; limit: string; asOf?: string; json: boolean; molabUrl: string }) => {
      resolve({ mode: "research", action: "replay", query: {
        ...(options.project && { projectId: options.project }), ...(options.experiment && { experimentId: options.experiment }),
        ...(options.run && { runId: options.run }), ...(options.kind && { kind: options.kind }),
        ...(options.asOf && { asOf: options.asOf }), offset: Number(options.offset), limit: Number(options.limit),
      }, json: options.json, molabUrl: options.molabUrl });
    });
  research
    .command("amend")
    .description("widen a delegation's budget or authority, with a recorded reason")
    .argument("<delegation>", "workspace-relative path of the Delegation document")
    .requiredOption("--reason <text>", "why the terms change (recorded on the delegation)")
    .option("--budget <key=value>", "new limit for a budget line (worker_usd, worker_runs, executions, wall_hours); repeatable", collect, [])
    .option("--add-action <action>", "grant one more action; repeatable", collect, [])
    .option("--by <name>", "who amends", process.env.USER ?? "operator")
    .option("--molab-url <url>", "molab serve URL", process.env.MOLAB_URL ?? "http://localhost:8000")
    .action((delegation: string, options: { reason: string; budget: string[]; addAction: string[]; by: string; molabUrl: string }) => {
      resolve({
        mode: "research",
        action: "amend",
        delegation,
        budget: parseBudget(options.budget),
        addActions: options.addAction,
        reason: options.reason,
        by: options.by,
        molabUrl: options.molabUrl,
      });
    });

  const plugin = program
    .command("plugin")
    .description("install, remove, enable, disable, and list a profile's plugins")
    .addHelpText("after", `\nPlugins go into one profile (default: ${DEFAULT_RUN_PROFILE}); pass --profile supervise for delegated execution.\n`);
  const pluginAction = (action: PluginAction, args: string, description: string) =>
    plugin
      .command(action)
      .description(description)
      .argument(args)
      .option("--profile <name>", `Tack profile to manage (default: ${DEFAULT_RUN_PROFILE})`, selectProfile)
      .action((names: string[] | undefined, options: { profile?: string }) => {
        resolve({ mode: "plugin", action, profile: options.profile ?? DEFAULT_RUN_PROFILE, names: names ?? [] });
      });
  pluginAction("add", "<spec...>", "install plugin packages (registry names, tarballs, or paths)");
  pluginAction("remove", "<name...>", "uninstall plugin packages");
  pluginAction("enable", "<name...>", "enable installed bundles");
  pluginAction("disable", "<name...>", "disable installed bundles without uninstalling them");
  plugin
    .command("list")
    .description("list installed plugins")
    .option("--profile <name>", `Tack profile to list (default: ${DEFAULT_RUN_PROFILE})`, selectProfile)
    .action((options: { profile?: string }) => {
      resolve({ mode: "plugin", action: "list", profile: options.profile ?? DEFAULT_RUN_PROFILE, names: [] });
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
