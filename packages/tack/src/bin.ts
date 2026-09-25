#!/usr/bin/env node
/** Command-line entry for Tack. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { helpText, parseTackArgs } from "./cli.js";
import { formatVersion, runApp } from "./commands.js";
import { collectDoctorReport, doctorExitCode, formatDoctorReport } from "./doctor.js";
import { resolveTackHome } from "./home.js";
import { REQUIRED_ROW_IDS, bindHome, loadRuntime } from "./runtime/dsh.js";

/** Downstream runtime patches applied by this Tack build. None until patch infrastructure lands. */
const PATCH_COUNT = 0;

function tackVersion(): string {
  const manifest = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

async function main(): Promise<void> {
  const tackHome = resolveTackHome();
  bindHome(tackHome);

  let invocation;
  try {
    invocation = parseTackArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  if (invocation.mode === "help") {
    process.stdout.write(helpText());
    return;
  }

  const runtime = await loadRuntime(tackHome);

  switch (invocation.mode) {
    case "version":
      process.stdout.write(
        formatVersion({ tack: tackVersion(), runtimeName: runtime.name, runtimeVersion: runtime.version, patches: PATCH_COUNT }),
      );
      return;
    case "doctor": {
      if (invocation.dumpConfig) {
        process.stdout.write(runtime.renderDump(invocation.profile, []));
        return;
      }
      const report = collectDoctorReport(runtime, {
        tackVersion: tackVersion(),
        home: tackHome,
        profile: invocation.profile,
        requiredRowIds: REQUIRED_ROW_IDS,
      });
      process.stdout.write(formatDoctorReport(report));
      process.exitCode = doctorExitCode(report);
      return;
    }
    case "run":
    case "web":
      try {
        await runApp(runtime, invocation);
      } catch (error) {
        if (runtime.isStartupError(error)) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
      return;
  }
}

await main();
