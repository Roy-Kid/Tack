/**
 * M3 exit criterion: a third-party capability is packaged, installed,
 * disabled, enabled, and removed without modifying the Tack repository.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readJson, spawnTack, tempHome } from "../helpers.js";

const EXAMPLE_DIR = join(REPO_ROOT, "examples", "plugin-echo");
const example = readJson<{ name: string; version: string }>(join(EXAMPLE_DIR, "package.json"));
const TOOL = "tack_echo";

let home: string;
let packDir: string;
let tarball: string;

beforeAll(() => {
  home = tempHome();
  packDir = mkdtempSync(join(tmpdir(), "tack-plugin-pack-"));
  execFileSync("npm", ["pack", EXAMPLE_DIR, "--pack-destination", packDir, "--silent"], { stdio: "ignore" });
  const file = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  if (file === undefined) throw new Error("npm pack produced no tarball");
  tarball = join(packDir, file);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
});

const tools = async () => {
  const result = await spawnTack(["doctor", "--tools"], { home });
  expect(result.code).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
};

const plugins = async () => {
  const result = await spawnTack(["plugin", "list"], { home });
  expect(result.code).toBe(0);
  return result.stdout;
};

describe("plugin lifecycle", () => {
  it("does not have the tool before install", async () => {
    expect(await tools()).not.toContain(TOOL);
  });

  it("installs a packed plugin and enables it", async () => {
    const result = await spawnTack(["plugin", "add", tarball], { home });
    expect(result.code).toBe(0);
    const list = await plugins();
    expect(list).toContain(`${example.name}@${example.version}`);
    expect(list).toContain("enabled");
    expect(list).toContain("(compatible)");
    expect(await tools()).toContain(TOOL);
  });

  it("disables without uninstalling", async () => {
    expect((await spawnTack(["plugin", "disable", example.name], { home })).code).toBe(0);
    expect(await plugins()).toContain("disabled");
    expect(await tools()).not.toContain(TOOL);
    expect(existsSync(join(home, "profiles", "default", "node_modules", example.name, "package.json"))).toBe(true);
  });

  it("re-enables", async () => {
    expect((await spawnTack(["plugin", "enable", example.name], { home })).code).toBe(0);
    expect(await tools()).toContain(TOOL);
  });

  it("refuses to disable a bundle from the profile template", async () => {
    const result = await spawnTack(["plugin", "disable", "@tack/bundle-default"], { home });
    expect(result.code).toBe(1);
  });

  it("removes the plugin", async () => {
    expect((await spawnTack(["plugin", "remove", example.name], { home })).code).toBe(0);
    expect(await plugins()).not.toContain(example.name);
    expect(existsSync(join(home, "profiles", "default", "node_modules", example.name))).toBe(false);
    expect(await tools()).not.toContain(TOOL);
  });
});
