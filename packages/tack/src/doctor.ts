import { existsSync } from "node:fs";
import type { ProfileInfo, Runtime } from "./runtime/dsh.js";

export interface DoctorReport {
  tack: string;
  runtime?: { name: string; version: string };
  node: string;
  home: string;
  homeExists: boolean;
  profiles: ProfileInfo[];
  apiKeySet: boolean;
  packageManager?: { name: string; version: string };
  compose?: { profile: string; rows: number; missing: string[] };
  error?: string;
}

export interface DoctorContext {
  tackVersion: string;
  home: string;
  profile: string;
  requiredRowIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

export function collectDoctorReport(runtime: Runtime | undefined, context: DoctorContext): DoctorReport {
  const env = context.env ?? process.env;
  const report: DoctorReport = {
    tack: context.tackVersion,
    node: context.nodeVersion ?? process.version,
    home: context.home,
    homeExists: existsSync(context.home),
    profiles: [],
    apiKeySet: Boolean(env.DEEPSEEK_API_KEY),
  };
  if (runtime === undefined) {
    report.error = "runtime not loaded";
    return report;
  }
  report.runtime = { name: runtime.name, version: runtime.version };
  report.packageManager = runtime.packageManager;
  try {
    runtime.ensureProfile(context.profile);
    report.profiles = runtime.listProfiles();
    const ids = runtime.composeRowIds(context.profile);
    report.compose = {
      profile: context.profile,
      rows: ids.length,
      missing: context.requiredRowIds.filter((id) => !ids.includes(id)),
    };
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Tack        ${report.tack}`);
  lines.push(`Runtime     ${report.runtime ? `${report.runtime.name} ${report.runtime.version}` : "not loaded"}`);
  lines.push(`Node        ${report.node}`);
  lines.push(`TACK_HOME   ${report.home}${report.homeExists ? "" : " (missing)"}`);
  lines.push(`DEEPSEEK_API_KEY: ${report.apiKeySet ? "set" : "not set"}`);
  lines.push(`Plugins     ${report.packageManager ? `${report.packageManager.name} ${report.packageManager.version} (bundled)` : "unavailable"}`);
  lines.push("Profiles");
  if (report.profiles.length === 0) lines.push("  (none)");
  for (const profile of report.profiles) {
    lines.push(`  ${profile.name}: ${profile.bundles.join(", ") || "(no bundles)"}`);
    for (const skipped of profile.skipped) lines.push(`    skipped ${skipped.packageName}: ${skipped.reason}`);
  }
  if (report.compose) {
    const status = report.compose.missing.length === 0 ? "required rows present" : `missing ${report.compose.missing.join(", ")}`;
    lines.push(`Compose     ${report.compose.profile}: ${report.compose.rows} rows, ${status}`);
  }
  if (report.error) lines.push(`Error       ${report.error}`);
  return lines.join("\n") + "\n";
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  if (report.error !== undefined) return 1;
  if (report.compose === undefined || report.compose.missing.length > 0) return 1;
  return 0;
}
