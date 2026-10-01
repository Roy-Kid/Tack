/**
 * The Tack runtime, currently backed by DeepSeek Harness (DSH).
 *
 * This is the only module in Tack that imports `@deepseek-ai/*`. Everything it
 * exports is Tack-shaped; no runtime types leak out. All DSH imports are
 * dynamic so the home binding below runs before any runtime module loads.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileTemplateBundles } from "../profiles.js";
import { bootProfile } from "./boot.js";
import * as models from "./models.js";
import type { ModelSelection, ProviderModels, ProviderRoute } from "./models.js";
import { bundledPnpm, readTackCompat, type PluginRecord } from "./plugins.js";

export type { PluginRecord } from "./plugins.js";
export type { ModelSelection, ProviderModels, ProviderRoute } from "./models.js";

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
const TACK_BUNDLE_BASE = "@tack/base";
const TACK_BUNDLE_RUN = "@tack/run";
const TACK_BUNDLE_WEB = "@tack/web";

/**
 * Tack profile templates: the ordered bundle stack each named profile starts
 * from. Template bundles are managed by Tack: on load, a template profile's
 * list is reconciled to the template, keeping user-added bundles after it.
 */
export const PROFILE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  default: [RUNTIME_BUNDLE_BASE, RUNTIME_BUNDLE_HEADLESS, TACK_BUNDLE_BASE, TACK_BUNDLE_RUN],
  web: [RUNTIME_BUNDLE_BASE, RUNTIME_BUNDLE_WEB, TACK_BUNDLE_BASE, TACK_BUNDLE_WEB],
};

/** The app bundles: the runtime's and Tack's. Rows they insert are switched off in host-plane boots. */
const APP_BUNDLES: readonly string[] = [RUNTIME_BUNDLE_HEADLESS, RUNTIME_BUNDLE_WEB, TACK_BUNDLE_RUN, TACK_BUNDLE_WEB];

/** Credentials are shared by every profile; this profile's host plane serves the store. */
const CREDENTIAL_PROFILE = "default";

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
  /** A model for this run only; saved settings are not touched. */
  model?: ModelSelection;
  /** Row configs for this run only, by row id; each replaces that row's config. */
  rowConfigs?: Readonly<Record<string, unknown>>;
}

export interface CredentialStatus {
  ref: string;
  configured: boolean;
  source?: string;
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
  currentModel(name: string): Promise<ModelSelection>;
  listModels(name: string, provider?: string): Promise<ProviderModels[]>;
  /** Save the default model in a profile; `listed` is false when the provider does not list the model. */
  useModel(name: string, selection: ModelSelection): Promise<{ listed: boolean }>;
  /** Routable providers, and the routes Tack configured through the multi-provider adapter. */
  listRoutes(name: string): Promise<{ routable: { id: string; name: string }[]; configured: Record<string, ProviderRoute> }>;
  addRoute(name: string, id: string, route: ProviderRoute): Promise<void>;
  removeRoute(name: string, id: string): Promise<boolean>;
  /** Store a credential in Tack's shared credential file. */
  setCredential(ref: string, value: string): Promise<void>;
  credentialStatus(refs: readonly string[]): Promise<CredentialStatus[]>;
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
  const [appBoot, homePaths, pluginOps, atomicWrite, cmdline, httpProxy, launchEnvironment] = await Promise.all([
    import("@deepseek-ai/dsh-app-boot"),
    import("@deepseek-ai/dsh-home-paths"),
    import("@deepseek-ai/dsh-plugin-manager/operations"),
    import("@deepseek-ai/dsh-atomic-write"),
    import("@deepseek-ai/dsh-cmdline"),
    import("@deepseek-ai/dsh-http-proxy"),
    import("@deepseek-ai/dsh-launch-environment"),
  ]);
  const credentials = await import("@deepseek-ai/dsh-credentials");
  const bootModules = { appBoot, cmdline, httpProxy, launchEnvironment };
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
    } else {
      const template = PROFILE_TEMPLATES[name];
      if (template !== undefined) {
        const manifest = appBoot.readProfileManifest(BIN_NAME, dir);
        const next = reconcileTemplateBundles(manifest.dsh?.profile?.bundles ?? [], template);
        if (next !== undefined) appBoot.writeProfileBundles(dir, manifest, next);
      }
    }
    const root = join(dir, PROFILE_ROOT_FILENAME);
    if (!existsSync(root)) writeFileSync(root, PROFILE_ROOT_CONFIG);
    return appBoot.loadProfileDirectory(BIN_NAME, dir, INSTALL_ANCHOR);
  };

  const composeLayers = (profile: ReturnType<typeof appBoot.loadProfileDirectory>) => [
    ...profile.layers.map((layer) => layer.patches),
    profile.patches,
  ];

  const start = (name: string, profile: ReturnType<typeof appBoot.loadProfileDirectory>, patchFiles: readonly string[], args: readonly string[]) =>
    bootProfile(bootModules, {
      binName: BIN_NAME,
      name,
      profile,
      installAnchor: INSTALL_ANCHOR,
      home: tackHome,
      patchFiles,
      args,
      packageManager: pnpm.invocation,
      rootFilename: PROFILE_ROOT_FILENAME,
      rootConfig: PROFILE_ROOT_CONFIG,
    });

  /**
   * Boot a profile with its app switched off and run `use` on the booted
   * context, then shut down. The full bundle stack is kept, so the runtime's
   * own re-composition (settings writes reconcile against the profile's files
   * plus these overlays) sees exactly what booted. The overlay disables every
   * row an app bundle inserts, Tack's startup rows, and live reload: nothing
   * runs, serves, or reloads mid-command.
   */
  const withHostPlane = async <T>(name: string, use: (ctx: { get(service: string): unknown }) => Promise<T> | T): Promise<T> => {
    const loaded = load(name);
    const ids = new Set<string>(["hmr"]);
    for (const layer of loaded.layers) {
      if (!APP_BUNDLES.includes(layer.packageName)) continue;
      for (const patch of layer.patches as { insert?: { id?: string }[] }[]) {
        for (const entry of patch.insert ?? []) if (typeof entry.id === "string") ids.add(entry.id);
      }
    }
    const file = join(mkdtempSync(join(tmpdir(), "tack-host-")), "host-plane.patch.yml");
    writeFileSync(file, [...ids].map((id) => `- id: ${JSON.stringify(id)}\n  disabled: true\n`).join(""));
    const { ctx, shutdown } = await start(name, loaded, [file], []);
    try {
      return await use(ctx as unknown as { get(service: string): unknown });
    } finally {
      await shutdown.shutdown(0);
    }
  };

  /** A one-run overlay replacing row configs; the saved profile layer is untouched. */
  const configOverlay = (configs: Readonly<Record<string, unknown>>): string => {
    const dir = mkdtempSync(join(tmpdir(), "tack-overlay-"));
    const file = join(dir, "run.patch.yml");
    writeFileSync(
      file,
      Object.entries(configs)
        .map(([id, config]) => `- id: ${JSON.stringify(id)}\n  config: ${JSON.stringify(config)}\n`)
        .join(""),
    );
    return file;
  };

  const credentialsService = (ctx: models.ServiceGetter) => {
    const credentials = ctx.get("credentials") as
      | {
          set(ref: unknown, value: string): Promise<void>;
          describe(ref: unknown): Promise<{ configured: boolean; source?: string }>;
        }
      | undefined;
    if (credentials === undefined) throw new Error("tack: the credential store is not available");
    return credentials;
  };

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
      const patchFiles = [...options.patchFiles];
      const configs: Record<string, unknown> = { ...options.rowConfigs };
      if (options.model !== undefined) configs["agent-default-model"] = { provider: options.model.provider, model: options.model.model };
      if (Object.keys(configs).length > 0) patchFiles.push(configOverlay(configs));
      await start(name, load(name), patchFiles, options.args);
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
    currentModel: (name) => withHostPlane(name, (ctx) => models.currentSelection(ctx)),
    listModels: (name, provider) => withHostPlane(name, (ctx) => models.listProviderModels(ctx, provider)),
    useModel: (name, selection) => withHostPlane(name, (ctx) => models.saveSelection(ctx, selection)),
    listRoutes: (name) =>
      withHostPlane(name, (ctx) => {
        const llm = ctx.get("llm") as { listProviders(): { id: string; name: string }[] } | undefined;
        return { routable: llm?.listProviders() ?? [], configured: models.configuredRoutes(ctx) };
      }),
    addRoute: (name, id, route) => withHostPlane(name, (ctx) => models.setRoute(ctx, id, route)),
    removeRoute: (name, id) => withHostPlane(name, (ctx) => models.removeRoute(ctx, id)),
    setCredential: (ref, value) =>
      withHostPlane(CREDENTIAL_PROFILE, (ctx) => credentialsService(ctx).set(credentials.credentialRef(ref), value)),
    credentialStatus: (refs) =>
      withHostPlane(CREDENTIAL_PROFILE, async (ctx) => {
        const store = credentialsService(ctx);
        const result: CredentialStatus[] = [];
        for (const ref of refs) {
          const info = await store.describe(credentials.credentialRef(ref));
          result.push({ ref, configured: info.configured, ...(info.source !== undefined && { source: info.source }) });
        }
        return result;
      }),
    listTools: (name) =>
      withHostPlane(name, (ctx) => {
        const tools = ctx.get("tools") as { schemas(): { name: string }[] } | undefined;
        if (tools === undefined) throw new Error(`tack: profile "${name}" mounts no tool registry`);
        return tools.schemas().map((schema) => schema.name).sort();
      }),
  };
}
