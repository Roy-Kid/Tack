/**
 * Install from source the way the README says, then use the installed `tack`
 * from outside the checkout. Catches anything that only works in the
 * developer's tree (install anchor, bundled package manager, asset paths).
 *
 * The checkout is the working tree's tracked and unignored files, so the test
 * covers uncommitted changes too.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FAKE_KEY, FAKE_KEY_ENV, type FakeModel, fakeProviderCommands, startFakeModel } from "../fake-model.js";
import { REPO_ROOT, spawnTack, tempHome } from "../helpers.js";

let root: string;
let checkout: string;
let prefix: string;
let bin: string;
let home: string;
let model: FakeModel;

const npm = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync("npm", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tack-install-"));
  checkout = join(root, "tack");
  prefix = join(root, "prefix");
  mkdirSync(prefix);
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(REPO_ROOT, file))) continue;
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(REPO_ROOT, file), join(checkout, file));
  }
  npm(["ci", "--no-audit", "--no-fund"], checkout);
  npm(["run", "build"], checkout);
  npm(["link", "-w", "tack"], checkout, { npm_config_prefix: prefix });
  bin = process.platform === "win32" ? join(prefix, "tack.cmd") : join(prefix, "bin", "tack");
  home = tempHome();
  model = await startFakeModel();
}, 900_000);

afterAll(async () => {
  await model?.close();
  rmSync(root, { recursive: true, force: true });
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

const tack = (args: string[], input?: string) => spawnTack(args, { home, bin, cwd: root, ...(input !== undefined && { input }) });

describe("tack installed from source", () => {
  it("is on the install prefix and reports its versions", async () => {
    expect(existsSync(bin)).toBe(true);
    const result = await tack(["version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Tack\s+\S+/m);
  });

  it("answers a task once a provider and key are set", async () => {
    for (const args of fakeProviderCommands(model)) expect((await tack(args)).code).toBe(0);
    expect((await tack(["auth", "set", FAKE_KEY_ENV], FAKE_KEY)).code).toBe(0);
    const doctor = await tack(["doctor"]);
    expect(doctor.stdout).toMatch(/^Ready\s+yes$/m);
    model.script([{ text: "Installed and answering." }]);
    const result = await tack(["run", "are you installed?"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Installed and answering.");
  });

  it("validates a web chrome file", async () => {
    const result = await tack(["web", "--chrome", join(checkout, "examples", "web-chrome", "chrome.json"), "--check"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--dsw-alias-bg-base");
  });
});
