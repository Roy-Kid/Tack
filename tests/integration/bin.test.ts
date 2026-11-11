/**
 * End-to-end tests of the built `tack` bin.
 *
 * These assert Tack's contract: CLI behaviour, exit codes, argument
 * forwarding, profile composition, and capability availability. They do not
 * assert the runtime's incidental output (wording, prefixes, help formatting,
 * diagnostic prose), so a runtime upgrade does not churn this suite.
 */
import { beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_TEMPLATES } from "../../packages/tack/src/runtime/dsh.js";
import { BIN, REPO_ROOT, readJson, spawnTack, tempHome } from "../helpers.js";

const tackManifest = readJson<{ version: string; dependencies: Record<string, string> }>(join(REPO_ROOT, "packages", "tack", "package.json"));
const RUNTIME_VERSION = tackManifest.dependencies["@deepseek-ai/dsh-app-boot"]!;

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`built bin missing at ${BIN}; run npm run build first`);
});

describe("tack version", () => {
  it("prints Tack and runtime versions for both spellings", async () => {
    const home = tempHome();
    for (const args of [["version"], ["--version"], ["-V"]]) {
      const result = await spawnTack(args, { home });
      expect(result.code).toBe(0);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(new RegExp(`^Tack\\s+${tackManifest.version.replaceAll(".", "\\.")}$`));
      expect(lines[1]).toContain(RUNTIME_VERSION);
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
    expect(existsSync(join(home, "profiles", "web"))).toBe(false);
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
    expect(result.stdout).toMatch(/^Model\s+deepseek-official\/\S+ \(DEEPSEEK_API_KEY not set\)$/m);
    expect(result.stdout).toMatch(/^Ready\s+no: .*tack auth set DEEPSEEK_API_KEY/m);

    const manifestPath = join(home, "profiles", "default", "package.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = readJson<{ dsh: { profile: { bundles: string[] } } }>(manifestPath);
    expect(manifest.dsh.profile.bundles).toEqual([...PROFILE_TEMPLATES.default!]);
    rmSync(home, { recursive: true, force: true });
  });

  it("composes the Tack bundle over the runtime's app bundle", async () => {
    const home = tempHome();
    const patch = readFileSync(join(REPO_ROOT, "bundles", "base", "cordis.patch.yml"), "utf8");
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

  it("exits 1 with a Tack diagnostic when no credentials are configured", async () => {
    const home = tempHome();
    const result = await spawnTack(["run", "hi"], { home });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).not.toBe("");
    // Tack owns the terminal: no runtime label reaches the user.
    expect(result.stderr.split("\n").filter((line) => line.startsWith("dsh"))).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it("migrates a profile created by an earlier Tack and keeps user plugins", async () => {
    const home = tempHome();
    const dir = join(home, "profiles", "default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "dsh-profile-default",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@tack/bundle-default", "user-plugin"] } },
      }),
    );
    expect((await spawnTack(["doctor"], { home })).code).toBe(0);
    const manifest = readJson<{ dsh: { profile: { bundles: string[] } } }>(join(dir, "package.json"));
    expect(manifest.dsh.profile.bundles).toEqual([...PROFILE_TEMPLATES.default!, "user-plugin"]);
    rmSync(home, { recursive: true, force: true });
  });
});
