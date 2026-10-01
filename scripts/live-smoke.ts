/**
 * One real agent turn against the configured provider, from the built `tack`.
 * Skips (exit 0) when DEEPSEEK_API_KEY is not set, so it is safe in any CI.
 *
 *   DEEPSEEK_API_KEY=... node scripts/live-smoke.ts
 *
 * Uses a throwaway TACK_HOME; asserts only that the turn completes with an
 * answer, since the model is real.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "tack", "lib", "bin.js");

if (!process.env.DEEPSEEK_API_KEY) {
  process.stdout.write("live smoke: DEEPSEEK_API_KEY is not set; skipped\n");
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), "tack-live-"));
try {
  const result = spawnSync(process.execPath, [BIN, "run", "Reply with the single word: pong"], {
    cwd: home,
    env: { ...process.env, TACK_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 180_000,
  });
  process.stderr.write(result.stderr ?? "");
  const answer = (result.stdout ?? "").trim();
  if (result.status !== 0 || answer === "") {
    process.stderr.write(`live smoke: failed (exit ${result.status}, ${answer === "" ? "no answer" : "answered"})\n`);
    process.exit(1);
  }
  process.stdout.write(`live smoke: ok (${answer.length} chars answered)\n`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
