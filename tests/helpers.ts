import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const BIN = join(REPO_ROOT, "packages", "tack", "lib", "bin.js");

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "tack-test-home-"));
}

/** Environment for a spawned Tack: isolated home, no credentials, telemetry off. */
export function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TACK_HOME: home, DSH_TELEMETRY_DISABLED: "1", ...extra };
  delete env.DEEPSEEK_API_KEY;
  delete env.DSH_HOME;
  return env;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function spawnTack(args: readonly string[], options: { home: string; input?: string }): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: testEnv(options.home), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export interface RunningTack {
  child: ChildProcess;
  /** The first line (on either stream) matching `pattern`. */
  matched: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start Tack and resolve once a line matching `pattern` appears on stdout or stderr. */
export function spawnTackUntil(args: readonly string[], options: { home: string; pattern: RegExp; timeoutMs?: number }): Promise<RunningTack> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: testEnv(options.home), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.on("close", (code, signal) => resolveExit({ code, signal }));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`no line matched ${options.pattern} within ${options.timeoutMs ?? 60_000}ms; output:\n${output}`));
    }, options.timeoutMs ?? 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (settled) return;
      for (const line of output.split("\n")) {
        if (options.pattern.test(line)) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ child, matched: line, exited });
          return;
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    void exited.then(({ code, signal }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`exited (code ${code}, signal ${signal}) before a line matched ${options.pattern}; output:\n${output}`));
    });
  });
}
