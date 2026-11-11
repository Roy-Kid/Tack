/**
 * Tack's profile launcher: mounts a loaded profile's composition on the
 * runtime's loader and owns the process lifecycle around it (proxy setup,
 * signals, fail-loud, bounded shutdown). Written against the runtime's public
 * boot exports; Tack does not depend on the runtime's own launcher package.
 * Runtime-facing; only the runtime module imports this file.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type AppBoot = typeof import("@deepseek-ai/dsh-app-boot");
type LoadedProfile = ReturnType<AppBoot["loadProfileDirectory"]>;
type BootedContext = Awaited<ReturnType<AppBoot["boot"]>>;

export interface BootModules {
  appBoot: AppBoot;
  cmdline: typeof import("@deepseek-ai/dsh-cmdline");
  httpProxy: typeof import("@deepseek-ai/dsh-http-proxy");
  launchEnvironment: typeof import("@deepseek-ai/dsh-launch-environment");
}

export interface BootRequest {
  binName: string;
  name: string;
  profile: LoadedProfile;
  installAnchor: string;
  home: string;
  patchFiles: readonly string[];
  args: readonly string[];
  packageManager: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> };
  rootFilename: string;
  rootConfig: string;
}

export interface ProcessShutdown {
  /** Dispose the tree, then let the process end with `code`. */
  shutdown(code: number): Promise<void>;
  /** Dispose the tree and exit; a second interrupt exits immediately. */
  interrupt(code: number): void;
}

/** Grace for the whole tree to dispose before the process is forced to exit. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

export function createProcessShutdown(
  dispose: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  complete: (code: number) => void = (code) => {
    process.exitCode = code;
  },
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const finish = (code: number, force: boolean) => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    if (force) exit(code);
    else complete(code);
  };
  const start = (code: number, force: boolean) => {
    if (pending !== undefined) return pending;
    timer = setTimeout(() => finish(code, true), timeoutMs);
    pending = Promise.resolve()
      .then(dispose)
      .then(
        () => finish(code, force),
        () => finish(code, true),
      );
    return pending;
  };
  return {
    shutdown: (code) => start(code, false),
    interrupt: (code) => {
      if (pending !== undefined) finish(code, true);
      else void start(code, true);
    },
  };
}

/**
 * Boot one profile and leave process lifetime to the app it mounts.
 * @returns the booted root context and its shutdown controller.
 */
export async function bootProfile(
  modules: BootModules,
  request: BootRequest,
): Promise<{ ctx: BootedContext; shutdown: ProcessShutdown }> {
  const { appBoot, cmdline, httpProxy, launchEnvironment } = modules;
  const { binName, profile } = request;
  const environment = appBoot.loadLayeredEnv(binName);
  const disposeProxy = await httpProxy.installProxyFromEnvironment(environment, (message) => {
    process.stderr.write(`${binName}: ${message}\n`);
  });

  let current: BootedContext | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      const failures: unknown[] = [];
      for (const release of [() => current?.fiber.dispose(), disposeProxy]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, `${binName}: profile cleanup failed`);
    })());

  try {
    writeFileSync(join(profile.dir, request.rootFilename), request.rootConfig);
    const resolution = await appBoot.createRuntimeResolution({ installAnchor: request.installAnchor, profile });
    const overlays = request.patchFiles.flatMap((file) => appBoot.loadOverlayPatches(binName, resolve(file)));

    const readyListeners = new Set<() => void>();
    let ready = false;
    const appReady = {
      onReady(listener: () => void) {
        if (ready) {
          listener();
          return () => {};
        }
        readyListeners.add(listener);
        return () => void readyListeners.delete(listener);
      },
    };

    const shutdown = createProcessShutdown(dispose);
    let interrupted = false;
    const interrupt = (code: number) => {
      interrupted = true;
      shutdown.interrupt(code);
    };
    process.on("SIGTERM", () => interrupt(0));
    process.on("SIGINT", () => interrupt(130));
    appBoot.installFailLoud(binName, process, async () => {
      await current?.fiber.dispose();
    });

    const profileContext = {
      name: request.name,
      packageManager: request.packageManager,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: request.installAnchor,
      startedBundles: profile.layers.map((layer) => layer.packageName),
      cwd: process.cwd(),
      home: request.home,
      overlays,
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    };
    const ctx = await appBoot.boot(
      binName,
      join(profile.dir, request.rootFilename),
      appBoot.readProfilePatches(binName, profileContext, profile),
      async (hostCtx) => {
        current = hostCtx;
        hostCtx.provide("profileContext", profileContext);
        hostCtx.provide(launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY, environment);
        await hostCtx.plugin(appBoot.PluginPackages, { resolution });
        cmdline.provideCmdline(hostCtx, {
          args: request.args,
          exit: (code) => void shutdown.shutdown(code),
          ready: appReady,
        });
      },
    );
    current = ctx;
    if (!interrupted && ctx.get("loader") !== undefined) {
      ready = true;
      for (const listener of [...readyListeners]) listener();
      readyListeners.clear();
    }
    return { ctx, shutdown };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${binName}: profile startup and cleanup failed`, { cause: cleanupError });
    }
    throw error;
  }
}
