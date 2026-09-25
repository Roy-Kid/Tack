import type { Runtime } from "./runtime/dsh.js";

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
  invocation: { profile: string; patches: readonly string[]; args: readonly string[] },
): Promise<void> {
  runtime.ensureProfile(invocation.profile);
  await runtime.boot(invocation.profile, { patchFiles: invocation.patches, args: invocation.args });
}
