/**
 * The Tack runtime, currently backed by DeepSeek Harness (DSH).
 *
 * This is the only module in Tack that imports `@deepseek-ai/*`. Everything it
 * exports is Tack-shaped; no runtime types leak out. All DSH imports are
 * dynamic so the home binding below runs before any runtime module loads.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPnpm, readTackCompat, type PluginRecord } from "./plugins.js";

export type { PluginRecord } from "./plugins.js";

/** The runtime reads only this variable for its home; Tack maps TACK_HOME onto it. */
const RUNTIME_HOME_ENV = "DSH_HOME";
/** Diagnostic prefix handed to runtime helpers. */
const BIN_NAME = "tack";
/** Directory under the Tack home holding profiles (the runtime's own layout). */
const PROFILES_DIR = "profiles";
/** Root config the runtime mounts a profile tree over; always an empty entry list. */
const PROFILE_ROOT_FILENAME = "cordis.yml";
const PROFILE_ROOT_CONFIG = `# Tack profile root: an empty entry list. The tree is composed from the
# bundles in package.json and cordis.patch.yml. Edit cordis.patch.yml, not this file.
[]
`;

/**
 * The package.json whose node_modules chain carries every runtime bundle. This
 * file is lib/runtime/dsh.js after build, so the anchor is two levels up.
 * Computed with path functions on purpose: the bundler rewrites
 * `new URL(..., import.meta.url)` into a copied asset.
 */
export const INSTALL_ANCHOR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

const RUNTIME_BUNDLE_BASE = "@deepseek-ai/dsh-base";
const RUNTIME_BUNDLE_HEADLESS = "@deepseek-ai/dsh-headless";
const RUNTIME_BUNDLE_WEB = "@deepseek-ai/dsh-web-app";
const TACK_BUNDLE_DEFAULT = "@tack/bundle-default";

/** Tack profile templates: the ordered bundle stack each named profile starts from. */
export const PROFILE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  default: [RUNTIME_BUNDLE_BASE, RUNTIME_BUNDLE_HEADLESS, TACK_BUNDLE_DEFAULT],
  web: [RUNTIME_BUNDLE_BASE, RUNTIME_BUNDLE_WEB, TACK_BUNDLE_DEFAULT],
};

/** The runtime's app bundles. A profile without them boots only its host plane. */
const APP_BUNDLES: readonly string[] = [RUNTIME_BUNDLE_HEADLESS, RUNTIME_BUNDLE_WEB];

/** Row ids every Tack composition must carry; absence means the runtime cannot serve. */
export const REQUIRED_ROW_IDS: readonly string[] = ["agent-loop", "system-prompt"];

export interface SkippedBundle {
  packageName: string;
  reason: string;
}

export interface ProfileInfo {
  name: string;
  dir: string;
  /** Ordered bundle names from the profile manifest. */
  bundles: string[];
  /** Bundles that actually contributed a layer, in order. */
  layers: string[];
  skipped: SkippedBundle[];
}

export interface BootOptions {
  patchFiles: readonly string[];
  args: readonly string[];
}

export interface PluginCommandResult {
  exitCode: number;
  /** Packages the runtime refused as incompatible with its version. */
  incompatible: { name: string; version: string }[];
  /** Diagnostics file for a failed run. */
  logPath?: string;
}

export interface Runtime {
  /** Runtime implementation name and version, for diagnostics. */
  readonly name: string;
  readonly version: string;
  readonly home: string;
  /** The package manager Tack bundles for plugin installs. */
  readonly packageManager: { name: string; version: string };
  profileDir(name: string): string;
  /** Load a profile, creating it from its template on first use. */
  ensureProfile(name: string): ProfileInfo;
  listProfiles(): ProfileInfo[];
  /** Row ids of the composed tree (bundle layers then the profile's own patch layer). */
  composeRowIds(name: string): string[];
  /** The composed configuration as an annotated YAML document. */
  renderDump(name: string, patchFiles: readonly string[]): string;
  /** Boot a profile and hand process lifetime to the app it mounts. */
  boot(name: string, options: BootOptions): Promise<void>;
  /** Whether an error is a runtime startup failure whose message is user-facing. */
  isStartupError(error: unknown): error is Error;
  /** Install or remove plugin packages in a profile; new bundles are enabled automatically. */
  pluginCommand(name: string, verb: "add" | "remove", specs: readonly string[]): Promise<PluginCommandResult>;
  listPlugins(name: string): PluginRecord[];
  /** Enable or disable an installed bundle without reinstalling it. */
  setPluginEnabled(name: string, pluginName: string, enabled: boolean): Promise<void>;
  /**
   * Names of the tools a profile's agents can call, read from the live
   * registry. The profile boots without its app, so nothing runs or serves.
   */
  listTools(name: string): Promise<string[]>;
}

/**
 * Point the runtime's home at the Tack home. Must run before any runtime
 * module is imported. TACK_HOME always wins: a pre-existing runtime home holds
 * profiles whose names collide with Tack's own compositions.
 */
export function bindHome(
  tackHome: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const existing = env[RUNTIME_HOME_ENV];
  if (existing !== undefined && existing !== "" && existing !== tackHome) {
    warn(`tack: ignoring ${RUNTIME_HOME_ENV}=${existing}; Tack uses ${tackHome} (set TACK_HOME to change it)`);
  }
  env[RUNTIME_HOME_ENV] = tackHome;
}

/** Load the runtime. Imports the runtime lazily so {@link bindHome} takes effect first. */
export async function loadRuntime(tackHome: string): Promise<Runtime> {
  const [profileBoot, appBoot, homePaths, pluginOps, atomicWrite] = await Promise.all([
    import("@deepseek-ai/dsh/profile-boot"),
    import("@deepseek-ai/dsh-app-boot"),
    import("@deepseek-ai/dsh-home-paths"),
    import("@deepseek-ai/dsh-plugin-manager/operations"),
    import("@deepseek-ai/dsh-atomic-write"),
  ]);
  const pnpm = bundledPnpm();
  const boundHome = homePaths.resolveDshHome();
  if (resolve(boundHome) !== resolve(tackHome)) {
    throw new Error(`tack: runtime home is ${boundHome} but Tack home is ${tackHome}; bindHome() must run before the runtime loads`);
  }

  const profilesRoot = join(tackHome, PROFILES_DIR);
  const profileDir = (name: string): string => join(profilesRoot, name);

  const toInfo = (name: string, profile: ReturnType<typeof appBoot.loadProfileDirectory>): ProfileInfo => {
    const manifest = appBoot.readProfileManifest(BIN_NAME, profile.dir);
    return {
      name,
      dir: profile.dir,
      bundles: [...(manifest.dsh?.profile?.bundles ?? [])],
      layers: profile.layers.map((layer) => layer.packageName),
      skipped: profile.skippedBundles.map(({ packageName, reason }) => ({ packageName, reason })),
    };
  };

  const load = (name: string) => {
    const dir = profileDir(name);
    if (!existsSync(join(dir, "package.json"))) {
      const template = PROFILE_TEMPLATES[name];
      if (template === undefined) {
        throw new Error(`tack: unknown profile "${name}": no template of that name and ${dir} does not exist`);
      }
      mkdirSync(dir, { recursive: true });
      appBoot.initProfile(dir, template);
    }
    const root = join(dir, PROFILE_ROOT_FILENAME);
    if (!existsSync(root)) writeFileSync(root, PROFILE_ROOT_CONFIG);
    return appBoot.loadProfileDirectory(BIN_NAME, dir, INSTALL_ANCHOR);
  };

  const composeLayers = (profile: ReturnType<typeof appBoot.loadProfileDirectory>) => [
    ...profile.layers.map((layer) => layer.patches),
    profile.patches,
  ];

  const pluginLocation = (dir: string) => ({ binName: BIN_NAME, profileDir: dir, installAnchor: INSTALL_ANCHOR });
  const LOCK_WAIT_MS = 120_000;

  return {
    name: "DSH",
    version: appBoot.getDshRuntimeVersion(),
    home: tackHome,
    packageManager: { name: "pnpm", version: pnpm.version },
    profileDir,
    ensureProfile: (name) => toInfo(name, load(name)),
    listProfiles: () => {
      if (!existsSync(profilesRoot)) return [];
      return readdirSync(profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(profilesRoot, entry.name, "package.json")))
        .map((entry) => entry.name)
        .sort()
        .map((name) => {
          try {
            return toInfo(name, appBoot.loadProfileDirectory(BIN_NAME, profileDir(name), INSTALL_ANCHOR));
          } catch (error) {
            return { name, dir: profileDir(name), bundles: [], layers: [], skipped: [{ packageName: "*", reason: String(error) }] };
          }
        });
    },
    composeRowIds: (name) => appBoot.composeEntries(composeLayers(load(name))).map((entry) => entry.id),
    renderDump: (name, patchFiles) => {
      const profile = load(name);
      const layers = profile.layers.map((layer) => ({ label: layer.packageName, patches: layer.patches }));
      layers.push({ label: `${name}/${appBoot.PROFILE_PATCH_FILENAME}`, patches: profile.patches });
      const homePatches = appBoot.loadOptionalPatches(BIN_NAME, join(tackHome, appBoot.PROFILE_PATCH_FILENAME));
      if (homePatches !== undefined) layers.push({ label: `~/${appBoot.PROFILE_PATCH_FILENAME}`, patches: homePatches });
      for (const file of patchFiles) {
        layers.push({ label: file, patches: appBoot.loadOverlayPatches(BIN_NAME, resolve(file)) });
      }
      return appBoot.renderConfigDump(BIN_NAME, join(profile.dir, PROFILE_ROOT_FILENAME), layers);
    },
    boot: async (name, options) => {
      const profile = load(name);
      await profileBoot.runProfile({
        environment: appBoot.loadLayeredEnv(BIN_NAME),
        profile: name,
        resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
        patchFiles: options.patchFiles,
        args: options.args,
        packageManager: pnpm.invocation,
      });
    },
    isStartupError: (error): error is Error => error instanceof appBoot.StartupError,
    pluginCommand: async (name, verb, specs) => {
      const profile = load(name);
      const result = await pluginOps.runPluginCommand(
        { profile: name, dir: profile.dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd(), home: tackHome },
        [verb, ...specs],
        {
          ...pnpm.invocation,
          execution: "cli",
          outputBytes: 16_384,
          lockWaitMs: LOCK_WAIT_MS,
          lookupTimeoutMs: LOCK_WAIT_MS,
          onOutput: (text, stream) => void process[stream].write(text),
        },
      );
      return {
        exitCode: result.exitCode,
        incompatible: (result.incompatible ?? []).map(({ name: pkg, version }) => ({ name: pkg, version })),
        ...(result.exitCode !== 0 && { logPath: result.logPath }),
      };
    },
    listPlugins: (name) => {
      const profile = load(name);
      return appBoot.readProfilePlugins(pluginLocation(profile.dir)).dependencies.map((dependency) => {
        const tackCompat = readTackCompat(profile.dir, dependency.name);
        return {
          name: dependency.name,
          version: dependency.version,
          bundle: dependency.bundle,
          enabled: dependency.enabled,
          ...(tackCompat !== undefined && { tackCompat }),
        };
      });
    },
    setPluginEnabled: async (name, pluginName, enabled) => {
      const profile = load(name);
      const template = PROFILE_TEMPLATES[name] ?? [];
      if (!enabled && template.includes(pluginName)) {
        throw new Error(`tack: ${pluginName} is part of the "${name}" profile template and cannot be disabled`);
      }
      await atomicWrite.withFileLock(
        join(profile.dir, "package.json"),
        async () => {
          const inventory = appBoot.readProfilePlugins(pluginLocation(profile.dir));
          const plugin = inventory.dependencies.find((dependency) => dependency.name === pluginName);
          if (plugin === undefined) throw new Error(`tack: ${pluginName} is not installed in profile "${name}"`);
          if (!plugin.bundle) throw new Error(`tack: ${pluginName} is not a bundle; there is nothing to enable or disable`);
          const bundles = [...(inventory.manifest.dsh?.profile?.bundles ?? [])];
          const next = enabled
            ? bundles.includes(pluginName) ? bundles : [...bundles, pluginName]
            : bundles.filter((bundle) => bundle !== pluginName);
          appBoot.writeProfileBundles(profile.dir, inventory.manifest, next);
        },
        { waitMs: LOCK_WAIT_MS },
      );
    },
    listTools: async (name) => {
      const loaded = load(name);
      // Boot the host plane only: drop the app bundles so no runner starts and nothing serves.
      const hostOnly = { ...loaded, layers: loaded.layers.filter((layer) => !APP_BUNDLES.includes(layer.packageName)) };
      const { ctx, shutdown } = await profileBoot.runProfile({
        environment: appBoot.loadLayeredEnv(BIN_NAME),
        profile: name,
        resolvedProfile: { profile: hostOnly, installAnchor: INSTALL_ANCHOR },
        patchFiles: [],
        args: [],
        packageManager: pnpm.invocation,
      });
      try {
        const tools = ctx.get("tools") as { schemas(): { name: string }[] } | undefined;
        if (tools === undefined) throw new Error(`tack: profile "${name}" mounts no tool registry`);
        return tools.schemas().map((schema) => schema.name).sort();
      } finally {
        await shutdown.shutdown(0);
      }
    },
  };
}
