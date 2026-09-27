/** This package's root directory, from built `lib/` or from source alike. Path math, not `new URL`, on purpose. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@tack/web-chrome";

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${PACKAGE_NAME}: package root not found`);
    dir = parent;
  }
}

export const PACKAGE_ROOT = findRoot();

export const packageVersion = (): string =>
  (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
