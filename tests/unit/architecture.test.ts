/**
 * Architecture guard for delegation. Delegated agents are called by the model
 * through DSH's own subagent tools. Claude Code and the in-process subagent
 * are DSH's plugins. Codex is Tack's one subagent provider, `@tack/codex`,
 * over the official app-server protocol of a current Codex release: it is the
 * only place that implements DSH's subagent contract or touches `@openai/*`.
 * Tack drives no subagent itself and wraps no SDK.
 */
import { describe, expect, it } from "@rstest/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../helpers.js";

const PACKAGES = join(REPO_ROOT, "packages");

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
const imports = (file: string, pattern: RegExp) =>
  [...text(file).matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].some((match) => pattern.test(match[1]!));

describe("delegation architecture", () => {
  const CODEX = join(PACKAGES, "codex", "src");
  const outsideCodex = all.filter((file) => !file.startsWith(CODEX));

  it("implements DSH's subagent contract only in @tack/codex", () => {
    expect(outsideCodex.filter((file) => imports(file, /^@deepseek-ai\/dsh-subagent/)).map((file) => relative(REPO_ROOT, file))).toEqual([]);
    expect(all.filter((file) => /declare\s+module\s+["']@deepseek-ai\/dsh-subagent/.test(text(file))).map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it("wraps no SDK: Codex is spoken to over its app-server protocol, Claude Code through DSH's plugin", () => {
    expect(all.filter((file) => imports(file, /^@anthropic-ai\/|^@openai\/codex-sdk/)).map((file) => relative(REPO_ROOT, file))).toEqual([]);
    expect(outsideCodex.filter((file) => imports(file, /^@openai\//)).map((file) => relative(REPO_ROOT, file))).toEqual([]);
    const tack = JSON.parse(text(join(PACKAGES, "tack", "package.json"))) as { dependencies: Record<string, string> };
    expect(Object.keys(tack.dependencies).filter((name) => name.startsWith("@anthropic-ai/") || name.startsWith("@openai/") || name.startsWith("@tack/agent-") || name === "@tack/delegate")).toEqual([]);
    expect(tack.dependencies["@deepseek-ai/dsh-subagent-claude-code"]).toBe("0.2.1-rc.5");
    expect(tack.dependencies["@deepseek-ai/dsh-subagent-codex"]).toBeUndefined();
    expect(tack.dependencies["@tack/codex"]).toBeDefined();
  });

  it("runs a current Codex: the vendored protocol matches the installed release", () => {
    const vendored = text(join(CODEX, "protocol", "VERSION")).trim();
    const installed = (JSON.parse(text(join(REPO_ROOT, "node_modules", "@openai", "codex", "package.json"))) as { version: string }).version;
    expect(installed).toBe(vendored);
  });
});
