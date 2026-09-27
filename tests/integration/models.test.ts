/**
 * Model and provider switching: DeepSeek is the default, and any provider can
 * be added, selected in every Tack profile, used for one run, and removed.
 * Offline: built-in provider catalogs need no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDumpRows, spawnTack, tempHome } from "../helpers.js";

let home: string;
let chosen: string;

beforeAll(() => {
  home = tempHome();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const tack = (args: string[], input?: string) => spawnTack(args, { home, ...(input !== undefined && { input }) });

describe("model and provider switching", () => {
  it("starts on DeepSeek in every Tack profile", async () => {
    const result = await tack(["model"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("default: deepseek-official/");
    expect(result.stdout).toContain("web: deepseek-official/");
  });

  it("adds a provider route to every Tack profile", async () => {
    expect((await tack(["provider", "add", "anthropic", "--api-key-env", "ANTHROPIC_API_KEY"])).code).toBe(0);
    const list = await tack(["provider", "list"]);
    expect(list.code).toBe(0);
    for (const profile of ["default", "web"]) expect(list.stdout).toMatch(new RegExp(`^${profile}: .*anthropic`, "m"));
  });

  it("lists the provider's models", async () => {
    const result = await tack(["model", "list", "--provider", "anthropic"]);
    expect(result.code).toBe(0);
    const models = result.stdout.split("\n").filter((line) => line.startsWith("  anthropic/"));
    expect(models.length).toBeGreaterThan(0);
    chosen = models[0]!.trim().split(/\s+/)[0]!;
  });

  it("switches the default model in every Tack profile", async () => {
    expect((await tack(["model", "use", chosen])).code).toBe(0);
    const shown = await tack(["model"]);
    expect(shown.stdout).toContain(`default: ${chosen}`);
    expect(shown.stdout).toContain(`web: ${chosen}`);
    const dump = await tack(["doctor", "--dump-config"]);
    const row = parseDumpRows(dump.stdout).find((candidate) => candidate.id === "agent-default-model");
    expect(row?.lines).toContain("    provider: anthropic");
  });

  it("uses another model for one run without changing the saved default", async () => {
    const result = await tack(["run", "--model", "deepseek-official/deepseek-flash", "hi"]);
    expect(result.code).toBe(1);
    expect((await tack(["model", "--profile", "default"])).stdout).toContain(`default: ${chosen}`);
  });

  it("refuses an unknown provider", async () => {
    expect((await tack(["model", "use", "nosuch/model"])).code).toBe(1);
  });

  it("refuses to remove the default model's provider, then removes it after switching", async () => {
    expect((await tack(["provider", "remove", "anthropic"])).code).toBe(1);
    expect((await tack(["model", "use", "deepseek-official/deepseek-flash"])).code).toBe(0);
    expect((await tack(["provider", "remove", "anthropic"])).code).toBe(0);
    expect((await tack(["provider", "list"])).stdout).not.toContain("anthropic");
  });
});

describe("credentials", () => {
  it("stores a key from stdin in a private file and never prints it", async () => {
    const secret = "sk-test-not-a-real-key";
    const stored = await tack(["auth", "set", "TEST_REF"], secret);
    expect(stored.code).toBe(0);
    expect(stored.stdout + stored.stderr).not.toContain(secret);
    const status = await tack(["auth", "status", "TEST_REF", "DEEPSEEK_API_KEY"]);
    expect(status.stdout).toMatch(/^TEST_REF: set/m);
    expect(status.stdout).toMatch(/^DEEPSEEK_API_KEY: not set/m);
    expect(status.stdout).not.toContain(secret);
    const file = join(home, ".credentials.yaml");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("TEST_REF");
  });

  it("refuses an empty key", async () => {
    expect((await tack(["auth", "set", "EMPTY_REF"], "")).code).toBe(1);
  });
});
