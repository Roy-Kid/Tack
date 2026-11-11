/**
 * Profile plugin management backed by the runtime's own plugin manager and a
 * pnpm executable bundled with Tack. Runtime-facing; only the runtime module
 * imports this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** A package-manager executable handed to the runtime's plugin seam. */
export interface PackageManagerInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Locate the pnpm executable Tack depends on; users never need pnpm on PATH. */
export function bundledPnpm(): { invocation: PackageManagerInvocation; version: string } {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("pnpm/package.json");
  const dir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  const windowsExe = join(dir, "pnpm.exe");
  const command = process.platform === "win32" && existsSync(windowsExe) ? windowsExe : join(dir, "pnpm");
  return { invocation: { command, args: [], env: {} }, version: manifest.version };
}

export interface PluginRecord {
  name: string;
  version: string;
  /** Whether the package declares a runtime bundle layer. */
  bundle: boolean;
  /** Whether the bundle is in the profile's active bundle list. */
  enabled: boolean;
  /** The package's declared Tack compatibility range, from `package.json` `tack.compat`. */
  tackCompat?: string;
}

/** Read `tack.compat` from an installed plugin's manifest, if declared. */
export function readTackCompat(profileDir: string, name: string): string | undefined {
  const manifestPath = join(profileDir, "node_modules", name, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { tack?: { compat?: unknown } };
    return typeof manifest.tack?.compat === "string" ? manifest.tack.compat : undefined;
  } catch {
    return undefined;
  }
}
