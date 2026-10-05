/**
 * Real-model smoke checks from the built `tack`, each skipped (exit 0 for
 * that check) when its keys are not set, so the script is safe in any CI:
 *
 * - one agent turn (DEEPSEEK_API_KEY);
 * - one delegation: the `supervise` profile hands a failing-test fix to
 *   Claude (DEEPSEEK_API_KEY and ANTHROPIC_API_KEY).
 *
 *   DEEPSEEK_API_KEY=... ANTHROPIC_API_KEY=... node scripts/live-smoke.ts
 *
 * Uses throwaway homes and workspaces; since the models are real, it asserts
 * outcomes (an answer, a fixed file), never wording.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages", "tack", "lib", "bin.js");

function tack(home: string, cwd: string, args: string[], timeout = 180_000) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, TACK_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout,
  });
  process.stderr.write(result.stderr ?? "");
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

function turn(): boolean {
  const home = mkdtempSync(join(tmpdir(), "tack-live-"));
  try {
    const result = tack(home, home, ["run", "Reply with the single word: pong"]);
    if (result.status !== 0 || result.stdout === "") {
      process.stderr.write(`live smoke (turn): failed (exit ${result.status}, ${result.stdout === "" ? "no answer" : "answered"})\n`);
      return false;
    }
    process.stdout.write(`live smoke (turn): ok (${result.stdout.length} chars answered)\n`);
    return true;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function delegation(): boolean {
  const home = mkdtempSync(join(tmpdir(), "tack-live-"));
  const work = mkdtempSync(join(tmpdir(), "tack-live-work-"));
  try {
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "live-fixture", private: true, type: "module", scripts: { test: "node test.js" } }));
    writeFileSync(join(work, "sum.js"), "export const sum = (a, b) => a - b;\n");
    writeFileSync(join(work, "test.js"), 'import { sum } from "./sum.js";\nif (sum(2, 3) !== 5) process.exit(1);\nconsole.log("ok");\n');
    // Headless: nobody can answer Claude's asks, so this run grants them.
    const patch = join(home, "live.patch.yml");
    writeFileSync(patch, "- id: agent-claude\n  config:\n    whenNoApprover: allow\n    maxTurns: 20\n    maxBudgetUsd: 1\n");
    const added = tack(home, work, ["plugin", "add", join(ROOT, "packages", "agent-claude"), "--profile", "supervise"]);
    if (added.status !== 0) {
      process.stderr.write(`live smoke (delegation): installing the Claude provider failed (exit ${added.status})\n`);
      return false;
    }
    const result = tack(home, work, ["run", "--profile", "supervise", "--patch", patch, "`npm test` fails in this workspace. Get it passing."], 600_000);
    const fixed = /a\s*\+\s*b/.test(readFileSync(join(work, "sum.js"), "utf8"));
    if (result.status !== 0 || !fixed) {
      process.stderr.write(`live smoke (delegation): failed (exit ${result.status}, sum.js ${fixed ? "fixed" : "unchanged"})\n`);
      return false;
    }
    process.stdout.write("live smoke (delegation): ok (sum.js fixed)\n");
    return true;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

let ok = true;
if (!process.env.DEEPSEEK_API_KEY) process.stdout.write("live smoke: DEEPSEEK_API_KEY is not set; skipped\n");
else {
  ok = turn() && ok;
  if (!process.env.ANTHROPIC_API_KEY) process.stdout.write("live smoke (delegation): ANTHROPIC_API_KEY is not set; skipped\n");
  else ok = delegation() && ok;
}
process.exit(ok ? 0 : 1);
