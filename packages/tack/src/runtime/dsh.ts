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

export interface Runtime {
  /** Runtime implementation name and version, for diagnostics. */
  readonly name: string;
  readonly version: string;
  readonly home: string;
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
  const [profileBoot, appBoot, homePaths] = await Promise.all([
    import("@deepseek-ai/dsh/profile-boot"),
    import("@deepseek-ai/dsh-app-boot"),
    import("@deepseek-ai/dsh-home-paths"),
  ]);
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

  return {
    name: "DSH",
    version: appBoot.getDshRuntimeVersion(),
    home: tackHome,
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
      });
    },
    isStartupError: (error): error is Error => error instanceof appBoot.StartupError,
  };
}
