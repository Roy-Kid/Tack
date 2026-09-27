import { resolveChrome } from "@tack/web-chrome/config";
import { chromeReport, chromeSource, loadChrome } from "./chrome.js";
import { parseSelection } from "./models.js";
import type { Runtime } from "./runtime/dsh.js";

/** The web bundle row that owns Tack's web chrome. */
export const CHROME_ROW_ID = "tack-web-chrome";

export interface VersionInfo {
  tack: string;
  runtimeName: string;
  runtimeVersion: string;
  patches: number;
}

/** Three lines: Tack, the runtime it currently uses, and the downstream patch count. */
export function formatVersion(info: VersionInfo): string {
  return `Tack      ${info.tack}\nRuntime   ${info.runtimeName} ${info.runtimeVersion}\nPatches   ${info.patches}\n`;
}

/** Boot a profile and leave process lifetime to the app it mounts. */
export async function runApp(
  runtime: Runtime,
  invocation: { profile: string; patches: readonly string[]; args: readonly string[]; model?: string },
): Promise<void> {
  runtime.ensureProfile(invocation.profile);
  await runtime.boot(invocation.profile, {
    patchFiles: invocation.patches,
    args: invocation.args,
    ...(invocation.model !== undefined && { model: parseSelection(invocation.model) }),
  });
}

/**
 * `tack web`: apply the chrome settings file (flag, else the home file) as a
 * one-run config for the chrome row, or with `--check` only report it.
 * @returns the exit code for `--check`; undefined once the app owns the process.
 */
export async function runWeb(
  runtime: Runtime,
  invocation: { profile: string; patches: readonly string[]; args: readonly string[]; chrome?: string; check: boolean },
  write: (text: string) => void,
): Promise<number | undefined> {
  const file = chromeSource(runtime.home, invocation.chrome);
  const chrome = file === undefined ? undefined : loadChrome(file);
  if (invocation.check) {
    write(`${chromeReport(file, chrome ?? resolveChrome(undefined))}\n`);
    return 0;
  }
  runtime.ensureProfile(invocation.profile);
  await runtime.boot(invocation.profile, {
    patchFiles: invocation.patches,
    args: invocation.args,
    ...(chrome !== undefined && { rowConfigs: { [CHROME_ROW_ID]: chrome } }),
  });
  return undefined;
}
