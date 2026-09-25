/**
 * Dependency isolation: the runtime is pinned exactly, and only the runtime
 * module knows it exists.
 */
import { describe, expect, it } from "@rstest/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, readJson } from "../helpers.js";

const RUNTIME_SCOPE = "@deepseek-ai/";
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const RUNTIME_MODULE_DIR = join(REPO_ROOT, "packages", "tack", "src", "runtime");

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
  const manifest = readJson<{ dependencies: Record<string, string> }>(join(REPO_ROOT, "packages", "tack", "package.json"));

  it("pins every runtime package to an exact version", () => {
    const runtimeDeps = Object.entries(manifest.dependencies).filter(([name]) => name.startsWith(RUNTIME_SCOPE));
    expect(runtimeDeps.length).toBeGreaterThan(0);
    for (const [name, range] of runtimeDeps) {
      expect(range, `${name} must be pinned exactly, got ${range}`).toMatch(EXACT_VERSION);
    }
  });

  it("pins every runtime package to the same version", () => {
    const versions = new Set(
      Object.entries(manifest.dependencies)
        .filter(([name]) => name.startsWith(RUNTIME_SCOPE))
        .map(([, range]) => range),
    );
    expect([...versions]).toHaveLength(1);
  });

  it("imports the runtime only from the runtime module", () => {
    const sources = [
      ...walk(join(REPO_ROOT, "packages", "tack", "src")),
      ...walk(join(REPO_ROOT, "packages", "plugins", "src")),
      ...walk(join(REPO_ROOT, "bundles")),
      ...walk(join(REPO_ROOT, "examples")),
    ];
    const offenders = sources
      .filter((file) => !file.startsWith(RUNTIME_MODULE_DIR))
      .filter((file) => /from\s+["']@deepseek-ai\/|import\(\s*["']@deepseek-ai\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
