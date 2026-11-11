import { parseSelection } from "./models.js";
import type { Runtime } from "./runtime/dsh.js";

export interface VersionInfo {
  tack: string;
  runtimeName: string;
  runtimeVersion: string;
}

/** Tack and its runtime versions. */
export function formatVersion(info: VersionInfo): string {
  return `Tack      ${info.tack}\nRuntime   ${info.runtimeName} ${info.runtimeVersion}\n`;
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
