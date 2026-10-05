/**
 * Architecture guard for delegation: DSH's subagent contract is the only
 * delegated-agent abstraction. Tack interprets it and implements it; it never
 * declares a second runtime interface, and the tool and its providers never
 * depend on each other.
 */
import { describe, expect, it } from "@rstest/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../helpers.js";

const PACKAGES = join(REPO_ROOT, "packages");
/** The one place allowed to extend DSH's contract, until upstream ships the addition. */
const SHIM_DIR = join(PACKAGES, "dsh-shims");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "lib") continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

const all = [...sources(PACKAGES), ...sources(join(REPO_ROOT, "bundles"))];
const text = (file: string) => readFileSync(file, "utf8");
const inPackage = (name: string) => all.filter((file) => file.startsWith(join(PACKAGES, name, "src")));
const imports = (file: string, pattern: RegExp) =>
  [...text(file).matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].some((match) => pattern.test(match[1]!));

describe("delegation architecture", () => {
  it("extends DSH's subagent contract only in the shim package", () => {
    const augmenting = all.filter((file) => /declare\s+module\s+["']@deepseek-ai\/dsh-subagent/.test(text(file))).map((file) => relative(REPO_ROOT, file));
    expect(augmenting.every((file) => join(REPO_ROOT, file).startsWith(SHIM_DIR))).toBe(true);
    expect(augmenting).toContain("packages/dsh-shims/subagent-events.d.ts");
  });

  it("declares no Tack run, provider, or runtime types", () => {
    // Aliases derived from DSH's own `SubagentRun` are reads of the contract, not declarations.
    const declaration = /\b(interface|type|class)\s+\w*(SubagentRun|AgentRun|RunHandle|AgentProvider|AgentRuntime|DelegationEvent|RunEvent)\b\s*(<[^>]*>)?\s*(\{|=(?!\s*NonNullable<SubagentRun\[))/;
    const declaring = all
      .filter((file) => !file.startsWith(SHIM_DIR))
      .filter((file) => declaration.test(text(file)))
      .map((file) => relative(REPO_ROOT, file));
    expect(declaring).toEqual([]);
  });

  it("keeps the delegate tool and its providers independent", () => {
    expect(inPackage("delegate").filter((file) => imports(file, /^@tack\/agent-|^@anthropic-ai\//))).toEqual([]);
    expect(inPackage("agent-claude").filter((file) => imports(file, /^@tack\/delegate/))).toEqual([]);
  });

  it("keeps the Claude Agent SDK inside its provider", () => {
    const offenders = all
      .filter((file) => !file.startsWith(join(PACKAGES, "agent-claude")))
      .filter((file) => imports(file, /^@anthropic-ai\//))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
    const tack = JSON.parse(text(join(PACKAGES, "tack", "package.json"))) as { dependencies: Record<string, string> };
    expect(Object.keys(tack.dependencies).filter((name) => name.startsWith("@anthropic-ai/") || name === "@tack/agent-claude")).toEqual([]);
  });
});
