/** Tack home resolution. Knows nothing about the runtime. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TACK_HOME_ENV = "TACK_HOME";
export const TACK_HOME_DIR_NAME = ".tack";

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Resolve the Tack home: `$TACK_HOME` when set and non-blank, else `~/.tack`.
 * @param env - environment to read; defaults to the process environment.
 * @param home - the user's home directory; defaults to `os.homedir()`.
 * @returns the absolute Tack home path (it may not exist yet).
 */
export function resolveTackHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env[TACK_HOME_ENV]?.trim();
  if (configured) return resolve(expandHome(configured, home));
  return join(home, TACK_HOME_DIR_NAME);
}
