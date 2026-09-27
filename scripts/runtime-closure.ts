/**
 * Runtime dependency-closure review. Every runtime package Tack installs is
 * reviewed once: its source group, its class, and Tack's decision.
 *
 *   node scripts/runtime-closure.ts list    installed runtime packages (from package-lock.json)
 *   node scripts/runtime-closure.ts write   classify and write packages/tack/runtime-closure.json
 *   node scripts/runtime-closure.ts diff    unreviewed / stale / forbidden packages; exit 1 if any
 *
 * Classification is a group rule table plus a short exception list. Per the
 * product rule, runtime core and UI components are used as they are; only
 * user-facing chrome, DeepSeek product policy, and experimental packages are
 * exceptions.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_SCOPE = "@deepseek-ai/";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCKFILE = join(REPO_ROOT, "package-lock.json");
export const CLOSURE_FILE = join(REPO_ROOT, "packages", "tack", "runtime-closure.json");
const INSTALLED = join(REPO_ROOT, "node_modules");

export type Class =
  | "engine"
  | "execution"
  | "capability"
  | "host-infra"
  | "browser-infra"
  | "composition"
  | "ui-component"
  | "chrome"
  | "provider"
  | "deepseek-policy"
  | "support"
  | "experimental";

export type Decision = "use" | "compose" | "wrap" | "disable" | "forbidden";

export interface Review {
  group: string;
  class: Class;
  decision: Decision;
}

export interface ClosureFile {
  runtime: string;
  packages: Record<string, Review>;
}

const GROUP_CLASS: Record<string, Class> = {
  core: "engine", session: "engine", "session-query": "engine", storage: "engine", typert: "engine",
  llm: "engine", boot: "engine", settings: "engine", credentials: "engine", identity: "engine",
  "runtime-diagnostics": "engine", attachment: "engine", spill: "engine", context: "engine",
  compaction: "engine", guard: "engine", entry: "engine",
  shell: "execution", subprocess: "execution", sandbox: "execution", terminal: "execution", fs: "execution",
  jobs: "execution", "ptc-runtime": "execution", native: "execution", wasm: "execution", workspace: "execution",
  subagent: "capability", skill: "capability", workflow: "capability", goal: "capability", plan: "capability",
  todo: "capability", mcp: "capability", web: "capability", interaction: "capability", deliverables: "capability",
  document: "capability", schedule: "capability", extensions: "capability", feedback: "capability",
  host: "host-infra", api: "host-infra",
  bundle: "composition", preset: "composition",
  util: "support", vendor: "support",
  experimental: "experimental",
};

/** Browser packages that are plumbing rather than presentation. */
const BROWSER_INFRA = new Set([
  "dsh-client-connection", "dsh-client-modules", "dsh-client-store", "dsh-client-resources", "dsh-client-locale",
  "dsh-client-shortcuts", "dsh-client-hmr", "dsh-client-file-upload", "dsh-client-ui-slots", "dsh-client-ui-renderer",
  "dsh-client-ui-session", "dsh-client-ui-primitives", "dsh-cordis-client-runner",
]);

/** The exceptions: user-facing chrome, DeepSeek product policy, and providers. */
const OVERRIDES: Record<string, Omit<Review, "group">> = {
  "dsh-client-ui-layout": { class: "chrome", decision: "wrap" },
  "dsh-web-frontend": { class: "chrome", decision: "wrap" },
  "dsh-client-ui-brand-official": { class: "chrome", decision: "disable" },
  "dsh-client-ui-settings-account": { class: "deepseek-policy", decision: "disable" },
  "dsh-client-ui-message-feedback": { class: "deepseek-policy", decision: "disable" },
  "dsh-api-account-controller": { class: "deepseek-policy", decision: "disable" },
  "dsh-session-telemetry-otel": { class: "deepseek-policy", decision: "disable" },
  "dsh-session-log-deepseek": { class: "deepseek-policy", decision: "disable" },
  "dsh-plugin-package-inventory-deepseek": { class: "deepseek-policy", decision: "disable" },
  "dsh-deepseek-account-platform": { class: "deepseek-policy", decision: "disable" },
  "dsh-llm-deepseek-account": { class: "deepseek-policy", decision: "disable" },
  "dsh-command-feedback": { class: "deepseek-policy", decision: "disable" },
  "dsh-message-feedback": { class: "deepseek-policy", decision: "disable" },
  "dsh-llm-deepseek": { class: "provider", decision: "use" },
  "dsh-llm-deepseek-api-key": { class: "provider", decision: "use" },
  "dsh-deepseek-llm-api-extensions": { class: "provider", decision: "use" },
  "dsh-web-search-deepseek": { class: "provider", decision: "use" },
  "dsh-llm-pi-ai": { class: "provider", decision: "use" },
};

const DEFAULT_DECISION: Record<Class, Decision> = {
  engine: "use", execution: "use", capability: "use", "host-infra": "use", "browser-infra": "use",
  composition: "compose", "ui-component": "use", chrome: "wrap", provider: "use",
  "deepseek-policy": "disable", support: "use", experimental: "forbidden",
};

/** Installed runtime package names, from the lockfile (every platform's entries). */
export function lockedClosure(lockfile = LOCKFILE): string[] {
  const lock = JSON.parse(readFileSync(lockfile, "utf8")) as { packages: Record<string, unknown> };
  const names = new Set<string>();
  for (const key of Object.keys(lock.packages)) {
    const at = key.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const name = key.slice(at + "node_modules/".length);
    if (name.startsWith(RUNTIME_SCOPE)) names.add(name);
  }
  return [...names].sort();
}

/** The source group from `repository.directory` (e.g. `packages/session/x` → `session`). */
export function groupOf(directory: string | undefined, name: string): string {
  const parts = (directory ?? "").split("/");
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "apps" || parts[0] === "vendor" || parts[0] === "native") return parts[0];
  return name.includes("node-addon") || name.includes("libreoffice-kit") ? "native" : "unknown";
}

export function classify(name: string, group: string): Review {
  const short = name.slice(RUNTIME_SCOPE.length);
  const override = OVERRIDES[short];
  if (override !== undefined) return { group, ...override };
  let klass: Class | undefined = GROUP_CLASS[group];
  if (group === "client") klass = BROWSER_INFRA.has(short) ? "browser-infra" : "ui-component";
  if (group === "apps") klass = "chrome";
  if (short.includes("experimental")) klass = "experimental";
  if (klass === undefined) throw new Error(`no review rule for ${name} (group "${group}"); add one to scripts/runtime-closure.ts`);
  return { group, class: klass, decision: DEFAULT_DECISION[klass] };
}

function installedDirectory(name: string): string | undefined {
  const manifest = join(INSTALLED, name, "package.json");
  if (!existsSync(manifest)) return undefined;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { repository?: { directory?: string } };
  return pkg.repository?.directory;
}

export interface ClosureDiff {
  unreviewed: string[];
  stale: string[];
  forbidden: string[];
}

export function diffClosure(installed: readonly string[], reviewed: ClosureFile): ClosureDiff {
  const known = new Set(Object.keys(reviewed.packages));
  const present = new Set(installed);
  return {
    unreviewed: installed.filter((name) => !known.has(name)),
    stale: [...known].filter((name) => !present.has(name)).sort(),
    forbidden: installed.filter((name) => reviewed.packages[name]?.decision === "forbidden"),
  };
}

export function readClosureFile(file = CLOSURE_FILE): ClosureFile {
  return JSON.parse(readFileSync(file, "utf8")) as ClosureFile;
}

function runtimeVersion(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "tack", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies[`${RUNTIME_SCOPE}dsh-app-boot`] ?? "unknown";
}

export function main(argv: string[]): number {
  const [command] = argv;
  switch (command) {
    case "list":
      process.stdout.write(lockedClosure().join("\n") + "\n");
      return 0;
    case "write": {
      const packages: Record<string, Review> = {};
      for (const name of lockedClosure()) packages[name] = classify(name, groupOf(installedDirectory(name), name));
      writeFileSync(CLOSURE_FILE, JSON.stringify({ runtime: runtimeVersion(), packages }, null, 2) + "\n");
      const counts = new Map<string, number>();
      for (const review of Object.values(packages)) counts.set(`${review.class}:${review.decision}`, (counts.get(`${review.class}:${review.decision}`) ?? 0) + 1);
      process.stdout.write([...counts].sort().map(([key, count]) => `${String(count).padStart(4)}  ${key}`).join("\n") + "\n");
      return 0;
    }
    case "diff": {
      const diff = diffClosure(lockedClosure(), readClosureFile());
      const lines = [
        ...diff.unreviewed.map((name) => `unreviewed  ${name}`),
        ...diff.stale.map((name) => `stale       ${name}`),
        ...diff.forbidden.map((name) => `forbidden   ${name}`),
      ];
      process.stdout.write(lines.length === 0 ? "runtime closure: every installed package is reviewed\n" : lines.join("\n") + "\n");
      return lines.length === 0 ? 0 : 1;
    }
    default:
      process.stderr.write("usage: runtime-closure.ts <list|write|diff>\n");
      return 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`runtime-closure: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
