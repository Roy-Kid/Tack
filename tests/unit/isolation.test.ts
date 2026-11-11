/**
 * Dependency isolation: the runtime is pinned exactly, and only Tack's
 * adapters import it: the runtime module (CLI) and the research plugin's DSH
 * adapter.
 * Claude Code and Codex come from DSH's published plugins, not from Tack source.
 */
import { describe, expect, it } from "@rstest/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, readJson } from "../helpers.js";

const RUNTIME_SCOPE = "@deepseek-ai/";
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const ADAPTER_DIRS = [
  join(REPO_ROOT, "packages", "tack", "src", "runtime"),
  join(REPO_ROOT, "packages", "research", "src", "dsh"),
  /** A DSH subagent provider: the whole package is runtime-facing. */
  join(REPO_ROOT, "packages", "codex", "src"),
];
/** Every manifest that names runtime packages, and the dependency fields it names them in. */
const PINNED_MANIFESTS = ["tack", "research", "codex"].map((dir) => join(REPO_ROOT, "packages", dir, "package.json"));

type Manifest = Partial<Record<"dependencies" | "peerDependencies" | "devDependencies", Record<string, string>>>;

function runtimePins(): [string, string, string][] {
  return PINNED_MANIFESTS.flatMap((path) => {
    const manifest = readJson<Manifest>(path);
    return (["dependencies", "peerDependencies", "devDependencies"] as const).flatMap((field) =>
      Object.entries(manifest[field] ?? {})
        .filter(([name]) => name.startsWith(RUNTIME_SCOPE))
        .map(([name, range]): [string, string, string] => [relative(REPO_ROOT, path), name, range]),
    );
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "lib") continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("runtime dependency isolation", () => {
  it("pins every runtime package to an exact version", () => {
    const pins = runtimePins();
    expect(pins.length).toBeGreaterThan(0);
    for (const [manifest, name, range] of pins) {
      expect(range, `${manifest}: ${name} must be pinned exactly, got ${range}`).toMatch(EXACT_VERSION);
    }
  });

  it("pins every runtime package to the same version", () => {
    expect([...new Set(runtimePins().map(([, , range]) => range))]).toHaveLength(1);
  });

  it("imports the runtime only from Tack's adapters", () => {
    const sources = [
      ...walk(join(REPO_ROOT, "packages", "tack", "src")),
      ...walk(join(REPO_ROOT, "packages", "plugins", "src")),
      ...walk(join(REPO_ROOT, "packages", "research", "src")),
      ...walk(join(REPO_ROOT, "packages", "codex", "src")),
      ...walk(join(REPO_ROOT, "bundles")),
      ...walk(join(REPO_ROOT, "examples")),
    ];
    const offenders = sources
      .filter((file) => !ADAPTER_DIRS.some((dir) => file.startsWith(dir)))
      .filter((file) => /from\s+["']@deepseek-ai\/|import\(\s*["']@deepseek-ai\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
