/**
 * Worker confinement: a worker session works inside the served Molab root.
 * Its file tools take paths inside the root, the temp directories or the
 * configured prefixes; its shell commands may name a path outside them only
 * as the executable (a venv's python, a system binary) or under a system
 * prefix. Everything here is pure: the DSH hook in `dsh/adapter.ts` asks
 * {@link confinementProblem} and refuses with {@link confinedRefusal}.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ResearchConfig } from "./config.js";

/** What the hook needs: the served root (fetched once) and the prefixes allowed besides it. */
export interface Confinement {
  root(): Promise<string>;
  allowed: readonly string[];
}

/**
 * The path argument of each file tool DSH registers, by tool name
 * (dsh-tool-fs: `file_path`; dsh-tool-fs-search: `path`; dsh-tool-working-directory: `cd`).
 */
export const PATH_PARAMS: Readonly<Record<string, string>> = {
  read: "file_path",
  read_image: "file_path",
  write: "file_path",
  edit: "file_path",
  glob: "path",
  grep: "path",
  working_directory: "cd",
};

/** The shell tool: its `command` is read token by token, and its `workdir` as a path. */
const SHELL_TOOL = "bash";

/** Where a confined worker may always read and write besides the root: the temp directories. */
export function defaultAllowed(): string[] {
  return [tmpdir(), "/private/tmp", "/tmp", "/var/folders"];
}

/** Where a shell command may point outside the root: the system, and Tack's own files. */
export function systemPrefixes(home = homedir()): string[] {
  return ["/usr", "/bin", "/sbin", "/opt", "/dev", "/etc", "/System", "/Library", "/Applications", "/proc", join(home, ".tack"), join(home, ".cache")];
}

const SYSTEM_PREFIXES = systemPrefixes();

/** The confinement a config asks for; undefined when it is off. */
export function confinementOf(config: ResearchConfig["workers"], root: () => Promise<string>): Confinement | undefined {
  return config.confine ? { root, allowed: [...defaultAllowed(), ...config.allowedPaths] } : undefined;
}

function within(path: string, prefix: string): boolean {
  const base = resolve(prefix);
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * The resolved path when it lies outside the root and every allowed prefix;
 * undefined when it is inside. A relative path resolves against the root (a
 * worker starts there), so one that climbs out is outside.
 */
export function pathVerdict(path: string, root: string, allowed: readonly string[]): string | undefined {
  const target = resolve(root, path);
  return [root, ...allowed].some((prefix) => within(target, prefix)) ? undefined : target;
}

// ── Shell commands ───────────────────────────────────────────────────────────

/** Pipeline and list operators, command substitution: each piece has its own command word (as `sleepsInShell` splits). */
const SEGMENT = /&&|\|\||[;|&\n]|\$\(|`/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that precede the real command word. */
const WRAPPERS: ReadonlySet<string> = new Set(["command", "exec", "env", "nohup", "nice", "time"]);
/** An absolute path inside a token: a `/` not continuing a word, a relative path, `~`, `$VAR` or a URL. */
const ABSOLUTE = /(?<![A-Za-z0-9_.~}\])*?/-])\/[^\s'"`;:,|&()<>]*/g;

/** Every absolute path a shell token names (`~` and `~/…` count as the home directory); a URL names none. */
function absolutePathsIn(token: string, home: string): string[] {
  if (token.includes("://")) return [];
  const expanded = token === "~" || token.startsWith("~/") ? `${home}${token.slice(1)}` : token;
  return [...expanded.matchAll(ABSOLUTE)].map((match) => match[0]);
}

/** The tokens of a command that are arguments: every word but the command word of each segment, plus the values of assignments. */
function argumentTokens(command: string): string[] {
  return command.split(SEGMENT).flatMap((segment) => {
    const words = segment.trim().split(/\s+/).filter((word) => word !== "");
    const tokens: string[] = [];
    let executableNext = true;
    for (const word of words) {
      if (ASSIGNMENT.test(word)) {
        tokens.push(word.slice(word.indexOf("=") + 1));
        continue;
      }
      if (executableNext) {
        executableNext = WRAPPERS.has(word);
        continue;
      }
      tokens.push(word);
    }
    return tokens;
  });
}

/**
 * The first absolute path a shell command's arguments name outside the root,
 * the allowed prefixes and the system; undefined when there is none. The
 * command word of each pipeline segment is exempt (`/…/.venv/bin/python
 * build.py` runs; `python /other/ws/build.py` does not).
 */
export function confinementVerdict(command: string, root: string, allowed: readonly string[], system: readonly string[] = SYSTEM_PREFIXES, home = homedir()): string | undefined {
  const prefixes = [...allowed, ...system];
  for (const token of argumentTokens(command)) {
    for (const path of absolutePathsIn(token, home)) {
      const outside = pathVerdict(path, root, prefixes);
      if (outside !== undefined) return outside;
    }
  }
  return undefined;
}

// ── Tool calls ───────────────────────────────────────────────────────────────

function stringArg(args: unknown, name: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The path a tool call reaches outside the confinement, or undefined when the
 * call stays inside (or the tool takes no path). File tools are judged by
 * their path argument; the shell by its arguments and `workdir`.
 */
export function confinementProblem(tool: string, args: unknown, root: string, allowed: readonly string[]): string | undefined {
  if (tool === SHELL_TOOL) {
    const workdir = stringArg(args, "workdir");
    const outsideWorkdir = workdir === undefined ? undefined : pathVerdict(workdir, root, [...allowed, ...SYSTEM_PREFIXES]);
    if (outsideWorkdir !== undefined) return outsideWorkdir;
    const command = stringArg(args, "command");
    return command === undefined ? undefined : confinementVerdict(command, root, allowed);
  }
  const param = PATH_PARAMS[tool];
  const path = param === undefined ? undefined : stringArg(args, param);
  return path === undefined ? undefined : pathVerdict(path, root, allowed);
}

/** Why a confined worker's call was refused: the tool, the path it reached, and where to work instead. */
export function confinedRefusal(tool: string, path: string, root: string): string {
  return (
    `Not run: ${tool} reaches ${path}, outside the served workspace. This session is a worker confined to ${root}: ` +
    `work inside ${root}; results from other workspaces must be given to you in the brief (ask for them in open_questions of your report).`
  );
}
