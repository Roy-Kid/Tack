/**
 * End-to-end tests of the built `tack` bin.
 *
 * These assert Tack's contract: CLI behaviour, exit codes, argument
 * forwarding, profile composition, and capability availability. They do not
 * assert the runtime's incidental output (wording, prefixes, help formatting,
 * diagnostic prose), so a runtime upgrade does not churn this suite.
 */
import { beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_TEMPLATES } from "../../packages/tack/src/runtime/dsh.js";
import { BIN, REPO_ROOT, readJson, spawnTack, spawnTackUntil, tempHome } from "../helpers.js";

const tackManifest = readJson<{ version: string; dependencies: Record<string, string> }>(join(REPO_ROOT, "packages", "tack", "package.json"));
const RUNTIME_VERSION = tackManifest.dependencies["@deepseek-ai/dsh"]!;
const WEB_DEFAULT_PORT = 3080;

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`built bin missing at ${BIN}; run npm run build first`);
});

describe("tack version", () => {
  it("prints Tack, runtime, and patch lines for both spellings", async () => {
    const home = tempHome();
    for (const args of [["version"], ["--version"], ["-V"]]) {
      const result = await spawnTack(args, { home });
      expect(result.code).toBe(0);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(new RegExp(`^Tack\\s+${tackManifest.version.replaceAll(".", "\\.")}$`));
      expect(lines[1]).toContain(RUNTIME_VERSION);
      expect(lines[2]).toMatch(/^Patches\s+\d+$/);
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tack (bare)", () => {
  it("prints Tack usage and exits 0", async () => {
    const home = tempHome();
    const result = await spawnTack([], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: tack");
    for (const command of ["run", "web", "doctor", "version"]) expect(result.stdout).toContain(command);
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects an unknown command with a non-zero exit", async () => {
    const home = tempHome();
    const result = await spawnTack(["frobnicate"], { home });
    expect(result.code).not.toBe(0);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tack doctor", () => {
  it("creates the default profile from the Tack template and reports a healthy composition", async () => {
    const home = tempHome();
    const result = await spawnTack(["doctor"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(home);
    expect(result.stdout).toContain(RUNTIME_VERSION);
    expect(result.stdout).toContain("DEEPSEEK_API_KEY: not set");

    const manifestPath = join(home, "profiles", "default", "package.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = readJson<{ dsh: { profile: { bundles: string[] } } }>(manifestPath);
    expect(manifest.dsh.profile.bundles).toEqual([...PROFILE_TEMPLATES.default!]);
    rmSync(home, { recursive: true, force: true });
  });

  it("composes the Tack bundle over the runtime's app bundle", async () => {
    const home = tempHome();
    const patch = readFileSync(join(REPO_ROOT, "bundles", "default", "cordis.patch.yml"), "utf8");
    const persona = /personaPrefix:\s*>-\s*\n\s+(.+)\n/.exec(patch)?.[1]?.trim();
    expect(persona, "test reads the persona from the bundle patch").toBeTruthy();

    const result = await spawnTack(["doctor", "--dump-config"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(persona!);
    rmSync(home, { recursive: true, force: true });
  });

  it("fails for a profile that has no template and does not exist", async () => {
    const home = tempHome();
    const result = await spawnTack(["doctor", "--profile", "no-such-profile"], { home });
    expect(result.code).toBe(1);
    expect(existsSync(join(home, "profiles", "no-such-profile"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tack run", () => {
  it("boots the default profile and prints Tack's run help", async () => {
    const home = tempHome();
    const result = await spawnTack(["run", "--help"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: tack run");
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a blank task with a usage error", async () => {
    const home = tempHome();
    const result = await spawnTack(["run", "   "], { home });
    expect(result.code).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 1 with a diagnostic when no credentials are configured", async () => {
    const home = tempHome();
    const result = await spawnTack(["run", "hi"], { home });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).not.toBe("");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tack web", () => {
  it("boots the web profile and prints Tack's web help", async () => {
    const home = tempHome();
    const result = await spawnTack(["web", "--help"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: tack web");
    rmSync(home, { recursive: true, force: true });
  });

  it("serves on a forwarded port, then stops on SIGINT", async () => {
    const home = tempHome();
    const running = await spawnTackUntil(["web", "--no-open", "--port", "0"], {
      home,
      pattern: /https?:\/\/127\.0\.0\.1:\d+\//,
      timeoutMs: 90_000,
    });
    try {
      const url = /https?:\/\/127\.0\.0\.1:\d+\/\S*/.exec(running.matched)![0];
      const parsed = new URL(url);
      expect(Number(parsed.port)).not.toBe(WEB_DEFAULT_PORT);
      expect(parsed.searchParams.get("token")).toBeTruthy();

      const response = await fetch(url, { redirect: "manual" });
      expect(response.status).toBeLessThan(500);

      const profile = readJson<{ dsh: { profile: { bundles: string[] } } }>(join(home, "profiles", "web", "package.json"));
      expect(profile.dsh.profile.bundles).toEqual([...PROFILE_TEMPLATES.web!]);
    } finally {
      running.child.kill("SIGINT");
    }
    const exit = await Promise.race([
      running.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("did not exit within 10s of SIGINT")), 10_000)),
    ]);
    expect(exit.code === 130 || exit.signal === "SIGINT").toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
