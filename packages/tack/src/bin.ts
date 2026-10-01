#!/usr/bin/env node
/** Command-line entry for Tack. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { helpText, parseTackArgs } from "./cli.js";
import { isChromeConfigError } from "./chrome.js";
import { formatVersion, runApp, runWeb } from "./commands.js";
import { runModelAction } from "./models.js";
import { runPluginAction } from "./plugin.js";
import { collectDoctorReport, doctorExitCode, formatDoctorReport } from "./doctor.js";
import { resolveTackHome } from "./home.js";
import { PROFILE_TEMPLATES, REQUIRED_ROW_IDS, bindHome, loadRuntime } from "./runtime/dsh.js";
import { installTerminalAdapter } from "./terminal.js";

/** Downstream runtime patches applied by this Tack build. None until patch infrastructure lands. */
const PATCH_COUNT = 0;

function tackVersion(): string {
  const manifest = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

/** A closed stdout (`tack ... | head`) ends the command quietly instead of crashing. */
function exitQuietlyOnClosedStdout(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

async function main(): Promise<void> {
  exitQuietlyOnClosedStdout();
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

  // Tack owns the terminal: runtime lines are relabelled before the runtime loads.
  // `tack run` keeps stdout untouched (it carries the answer or --json events).
  installTerminalAdapter({ stdout: invocation.mode === "web" });
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
      if (invocation.tools) {
        runtime.ensureProfile(invocation.profile);
        const tools = await runtime.listTools(invocation.profile);
        process.stdout.write(tools.map((tool) => `${tool}\n`).join(""));
        if (tools.length === 0) process.stderr.write(`tack: no tools are registered on the "${invocation.profile}" profile's host plane\n`);
        return;
      }
      const report = await collectDoctorReport(runtime, {
        tackVersion: tackVersion(),
        home: tackHome,
        profile: invocation.profile,
        requiredRowIds: REQUIRED_ROW_IDS,
      });
      process.stdout.write(formatDoctorReport(report));
      process.exitCode = doctorExitCode(report);
      return;
    }
    case "plugin":
      try {
        process.exitCode = await runPluginAction(runtime, invocation, tackVersion());
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    case "model":
    case "provider":
    case "auth":
      try {
        process.exitCode = await runModelAction(runtime, invocation, Object.keys(PROFILE_TEMPLATES));
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    case "run":
    case "web":
      try {
        if (invocation.mode === "web") {
          const code = await runWeb(runtime, invocation, (text) => process.stdout.write(text));
          if (code !== undefined) process.exitCode = code;
        } else {
          await runApp(runtime, invocation);
        }
      } catch (error) {
        if (runtime.isStartupError(error) || isChromeConfigError(error)) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
      return;
  }
}

await main();
