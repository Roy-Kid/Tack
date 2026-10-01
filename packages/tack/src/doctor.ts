import { existsSync } from "node:fs";
import type { ProfileInfo, Readiness, Runtime } from "./runtime/dsh.js";

export interface DoctorReport {
  tack: string;
  runtime?: { name: string; version: string };
  node: string;
  home: string;
  homeExists: boolean;
  profiles: ProfileInfo[];
  /** The default model and its key; absent when the profile could not be booted. */
  readiness?: Readiness;
  packageManager?: { name: string; version: string };
  compose?: { profile: string; rows: number; missing: string[] };
  error?: string;
}

export interface DoctorContext {
  tackVersion: string;
  home: string;
  profile: string;
  requiredRowIds: readonly string[];
  nodeVersion?: string;
}

export async function collectDoctorReport(runtime: Runtime | undefined, context: DoctorContext): Promise<DoctorReport> {
  const report: DoctorReport = {
    tack: context.tackVersion,
    node: context.nodeVersion ?? process.version,
    home: context.home,
    homeExists: existsSync(context.home),
    profiles: [],
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
    if (report.compose.missing.length === 0) report.readiness = await runtime.readiness(context.profile);
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
  if (report.readiness) {
    const { model, keyRef, keySet, keySource } = report.readiness;
    const key = keyRef === undefined ? "key reference unknown" : `${keyRef} ${keySet ? `set${keySource ? ` (${keySource})` : ""}` : "not set"}`;
    lines.push(`Model       ${model} (${key})`);
  }
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
  lines.push(readyLine(report));
  return lines.join("\n") + "\n";
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  if (report.error !== undefined) return 1;
  if (report.compose === undefined || report.compose.missing.length > 0) return 1;
  return 0;
}

/** One line saying whether `tack run` can answer now, and the next step when it cannot. */
export function readyLine(report: DoctorReport): string {
  if (doctorExitCode(report) !== 0 || report.readiness === undefined) return "Ready       no: fix the error above";
  const { keyRef, keySet } = report.readiness;
  if (keySet) return "Ready       yes";
  if (keyRef === undefined) return "Ready       unknown: the provider's key reference is not recorded; see `tack provider list`";
  return `Ready       no: set the key with \`tack auth set ${keyRef}\` (reads it from stdin), or export ${keyRef}`;
}
