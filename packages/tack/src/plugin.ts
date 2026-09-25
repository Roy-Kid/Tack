/** `tack plugin` handlers. Tack-shaped: no runtime imports. */
import semver from "semver";
import type { PluginRecord, Runtime } from "./runtime/dsh.js";

export type PluginAction = "add" | "remove" | "list" | "enable" | "disable";

export type CompatStatus = "compatible" | "incompatible" | "undeclared" | "invalid";

/** Whether a plugin's declared `tack.compat` range admits this Tack version. */
export function compatStatus(tackVersion: string, range: string | undefined): CompatStatus {
  if (range === undefined) return "undeclared";
  if (semver.validRange(range) === null) return "invalid";
  return semver.satisfies(tackVersion, range, { includePrerelease: true }) ? "compatible" : "incompatible";
}

export function formatPluginList(records: readonly PluginRecord[], tackVersion: string): string {
  if (records.length === 0) return "(no plugins installed)\n";
  const rows = records.map((record) => {
    const state = !record.bundle ? "not a bundle" : record.enabled ? "enabled" : "disabled";
    const compat = compatStatus(tackVersion, record.tackCompat);
    const compatText = compat === "undeclared" ? "" : `  tack ${record.tackCompat} (${compat})`;
    return `${record.name}@${record.version}  ${state}${compatText}`;
  });
  return rows.join("\n") + "\n";
}

export interface PluginInvocation {
  action: PluginAction;
  profile: string;
  names: string[];
}

export interface PluginIo {
  out(text: string): void;
  err(text: string): void;
}

const stdio: PluginIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** Run one `tack plugin` action; returns the process exit code. */
export async function runPluginAction(
  runtime: Runtime,
  invocation: PluginInvocation,
  tackVersion: string,
  io: PluginIo = stdio,
): Promise<number> {
  const { action, profile, names } = invocation;
  runtime.ensureProfile(profile);
  switch (action) {
    case "list":
      io.out(formatPluginList(runtime.listPlugins(profile), tackVersion));
      return 0;
    case "enable":
    case "disable":
      for (const name of names) await runtime.setPluginEnabled(profile, name, action === "enable");
      io.out(`${action}d ${names.join(", ")} in profile "${profile}"\n`);
      return 0;
    case "add":
    case "remove": {
      const before = new Set(runtime.listPlugins(profile).map((record) => record.name));
      const result = await runtime.pluginCommand(profile, action, names);
      for (const { name, version } of result.incompatible) {
        io.err(`tack: ${name}@${version} is not compatible with runtime ${runtime.name} ${runtime.version}; it was not installed\n`);
      }
      if (result.exitCode !== 0) {
        if (result.logPath) io.err(`tack: plugin ${action} failed; diagnostics: ${result.logPath}\n`);
        return result.exitCode;
      }
      if (action === "add") {
        for (const record of runtime.listPlugins(profile).filter((r) => !before.has(r.name))) {
          const compat = compatStatus(tackVersion, record.tackCompat);
          if (compat === "incompatible" || compat === "invalid") {
            io.err(`tack: warning: ${record.name} declares tack ${record.tackCompat}, which does not admit Tack ${tackVersion}\n`);
          }
        }
      }
      return 0;
    }
  }
}
