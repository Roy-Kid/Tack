/**
 * Runtime update tool: detect a new DSH release, re-pin every runtime
 * package to it, and report the result. Run with Node (type stripping):
 *
 *   node scripts/runtime-update.ts check [--tag next] [--version <exact>]
 *   node scripts/runtime-update.ts apply <version>
 *   node scripts/runtime-update.ts installed
 *   node scripts/runtime-update.ts report --from <v> --to <v> --outcome <success|failure> [--log <file>]
 *
 * `check` and `apply` also write `key=value` lines to $GITHUB_OUTPUT when set.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const RUNTIME_SCOPE = "@deepseek-ai/";
/** The package whose published versions define the runtime version. */
export const RUNTIME_PACKAGE = "@deepseek-ai/dsh";
export const DEFAULT_TAG = "next";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TACK_MANIFEST = join(REPO_ROOT, "packages", "tack", "package.json");

export interface Manifest {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** The runtime packages a manifest pins, name to version. */
export function runtimePins(manifest: Manifest): Record<string, string> {
  return Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith(RUNTIME_SCOPE)));
}

/** The single runtime version a manifest pins; throws when pins disagree or are not exact. */
export function currentRuntimeVersion(manifest: Manifest): string {
  const versions = new Set(Object.values(runtimePins(manifest)));
  if (versions.size !== 1) throw new Error(`runtime pins must agree on one version, found: ${[...versions].join(", ") || "none"}`);
  const [version] = versions as Set<string>;
  if (semver.valid(version) === null) throw new Error(`runtime pin ${version} is not an exact version`);
  return version!;
}

/** Whether `candidate` is newer than `current` (prereleases count). */
export function isUpdate(current: string, candidate: string): boolean {
  return semver.gt(candidate, current);
}

/** A copy of `manifest` with every runtime pin set to `version`. */
export function withRuntimeVersion(manifest: Manifest, version: string): Manifest {
  if (semver.valid(version) === null) throw new Error(`${version} is not an exact version`);
  const dependencies = { ...manifest.dependencies };
  for (const name of Object.keys(dependencies)) if (name.startsWith(RUNTIME_SCOPE)) dependencies[name] = version;
  return { ...manifest, dependencies };
}

export interface ReportInput {
  from: string;
  to: string;
  outcome: "success" | "failure";
  pins: string[];
  log?: string;
  logLines?: number;
}

/** The pull request body for one runtime update. */
export function renderReport(input: ReportInput): string {
  const verdict =
    input.outcome === "success"
      ? "Lint, typecheck, build, and the full test suite pass on the new runtime."
      : "**Verification failed on the new runtime.** Do not merge until the failure below is fixed on this branch.";
  const lines = [
    `Runtime update: DSH \`${input.from}\` → \`${input.to}\`.`,
    "",
    verdict,
    "",
    "**Re-pinned packages**",
    ...input.pins.map((name) => `- \`${name}\``),
    "",
    "**Patches:** none (Tack carries no runtime patches yet).",
    "",
    "Opened by the runtime update workflow, which ran the suite itself: pull requests created with the workflow token do not trigger other workflows.",
  ];
  if (input.log !== undefined && input.log.trim() !== "") {
    const tail = input.log.trimEnd().split("\n").slice(-(input.logLines ?? 80)).join("\n");
    lines.push("", "<details><summary>Verification log (tail)</summary>", "", "```", tail, "```", "", "</details>");
  }
  return lines.join("\n") + "\n";
}

/**
 * The version of `name` that resolves from `anchor` the way the runtime
 * resolves bundles: the first `node_modules/<name>/package.json` on Node's
 * lookup path. Independent of the package's `exports`.
 */
export function resolvedVersion(anchor: string, name: string): string | undefined {
  for (const dir of createRequire(anchor).resolve.paths(name) ?? []) {
    const manifest = join(dir, name, "package.json");
    if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
  }
  return undefined;
}

function npmView(spec: string, field: string): string | undefined {
  try {
    const out = execFileSync("npm", ["view", spec, field, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out === "") return undefined;
    const value = JSON.parse(out) as unknown;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function output(values: Record<string, string>): void {
  const target = process.env.GITHUB_OUTPUT;
  for (const [key, value] of Object.entries(values)) {
    process.stdout.write(`${key}=${value}\n`);
    if (target) appendFileSync(target, `${key}=${value}\n`);
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function main(argv: string[]): number {
  const [command, ...args] = argv;
  const manifestPath = option(args, "--manifest") ?? TACK_MANIFEST;
  switch (command) {
    case "check": {
      const current = currentRuntimeVersion(readManifest(manifestPath));
      const explicit = option(args, "--version");
      const tag = option(args, "--tag") ?? DEFAULT_TAG;
      const candidate = explicit ?? npmView(`${RUNTIME_PACKAGE}@${tag}`, "version");
      if (candidate === undefined || semver.valid(candidate) === null) {
        throw new Error(`could not resolve ${RUNTIME_PACKAGE}@${explicit ?? tag} to an exact version`);
      }
      output({ current, candidate, update: String(isUpdate(current, candidate)) });
      return 0;
    }
    case "apply": {
      const version = args.find((arg) => !arg.startsWith("--") && arg !== manifestPath);
      if (version === undefined) throw new Error("usage: apply <version>");
      const manifest = readManifest(manifestPath);
      const missing = Object.keys(runtimePins(manifest)).filter((name) => npmView(`${name}@${version}`, "version") !== version);
      if (missing.length > 0) throw new Error(`not published at ${version}: ${missing.join(", ")}`);
      writeFileSync(manifestPath, JSON.stringify(withRuntimeVersion(manifest, version), null, 2) + "\n");
      output({ applied: version, pins: Object.keys(runtimePins(manifest)).join(",") });
      return 0;
    }
    case "installed": {
      const pins = runtimePins(readManifest(manifestPath));
      const wrong = Object.entries(pins)
        .map(([name, version]) => ({ name, version, resolved: resolvedVersion(manifestPath, name) }))
        .filter(({ version, resolved }) => resolved !== version);
      for (const { name, version, resolved } of wrong) {
        process.stderr.write(`runtime-update: ${name} resolves to ${resolved ?? "nothing"}, pinned ${version}\n`);
      }
      if (wrong.length > 0) return 1;
      output({ installed: String(Object.keys(pins).length) });
      return 0;
    }
    case "report": {
      const from = option(args, "--from");
      const to = option(args, "--to");
      const outcome = option(args, "--outcome");
      if (from === undefined || to === undefined || (outcome !== "success" && outcome !== "failure")) {
        throw new Error("usage: report --from <v> --to <v> --outcome <success|failure> [--log <file>]");
      }
      const logPath = option(args, "--log");
      const log = logPath !== undefined && existsSync(logPath) ? readFileSync(logPath, "utf8") : undefined;
      const pins = Object.keys(runtimePins(readManifest(manifestPath)));
      process.stdout.write(renderReport({ from, to, outcome, pins, ...(log !== undefined && { log }) }));
      return 0;
    }
    default:
      process.stderr.write("usage: runtime-update.ts <check|apply|installed|report> ...\n");
      return 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`runtime-update: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
