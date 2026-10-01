/**
 * Tack web chrome settings: the one shape an integrator writes (as a JSON file
 * or as the `tack-web-chrome` row config). Strict: unknown keys are errors, so
 * a typo never silently falls back to a default. Pure: no I/O.
 */

export type Appearance = "light" | "dark" | "system";

export interface ChromeConfig {
  product: { name: string; shortName: string; titleSeparator: string };
  /** Absolute file paths once resolved; `null` uses Tack's built-in asset. */
  brand: { logo: string | null; logoDark: string | null; favicon: string | null; faviconDark: string | null };
  /** `css` and `customCss` hold stylesheet text once resolved. */
  theme: { css: string | null; customCss: string | null; source: string; appearance: Appearance };
  splash: { wordmark: string | null; hint: string };
  welcome: { enabled: boolean; title: string; body: string };
  version: { show: boolean };
  onboarding: { credentialPrompt: boolean };
}

export const DEFAULT_CHROME: ChromeConfig = {
  product: { name: "Tack", shortName: "Tack", titleSeparator: " — " },
  brand: { logo: null, logoDark: null, favicon: null, faviconDark: null },
  theme: { css: null, customCss: null, source: "theme", appearance: "system" },
  splash: { wordmark: null, hint: "Loading…" },
  welcome: { enabled: false, title: "", body: "" },
  version: { show: true },
  onboarding: { credentialPrompt: true },
};

export class ChromeConfigError extends Error {
  override name = "ChromeConfigError";
}

type Kind = "string" | "nullable-string" | "boolean" | "appearance";

const SHAPE: Record<string, Record<string, Kind>> = {
  product: { name: "string", shortName: "string", titleSeparator: "string" },
  brand: { logo: "nullable-string", logoDark: "nullable-string", favicon: "nullable-string", faviconDark: "nullable-string" },
  theme: { css: "nullable-string", customCss: "nullable-string", source: "string", appearance: "appearance" },
  splash: { wordmark: "nullable-string", hint: "string" },
  welcome: { enabled: "boolean", title: "string", body: "string" },
  version: { show: "boolean" },
  onboarding: { credentialPrompt: "boolean" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(kind: Kind, value: unknown, path: string): void {
  const ok =
    kind === "string" ? typeof value === "string"
    : kind === "nullable-string" ? value === null || typeof value === "string"
    : kind === "boolean" ? typeof value === "boolean"
    : value === "light" || value === "dark" || value === "system";
  if (!ok) {
    const expected = kind === "appearance" ? '"light", "dark", or "system"' : kind === "nullable-string" ? "a string or null" : `a ${kind}`;
    throw new ChromeConfigError(`chrome: ${path} must be ${expected}, got ${JSON.stringify(value)}`);
  }
}

/** Validate partial settings and fill every omitted key with Tack's default. */
export function resolveChrome(input: unknown): ChromeConfig {
  if (input === undefined || input === null) return structuredClone(DEFAULT_CHROME);
  if (!isObject(input)) throw new ChromeConfigError("chrome: settings must be an object");
  const result = structuredClone(DEFAULT_CHROME) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, value] of Object.entries(input)) {
    if (section === "$schema") continue;
    const fields = SHAPE[section];
    if (fields === undefined) throw new ChromeConfigError(`chrome: unknown setting "${section}"; expected one of ${Object.keys(SHAPE).join(", ")}`);
    if (!isObject(value)) throw new ChromeConfigError(`chrome: ${section} must be an object`);
    for (const [key, field] of Object.entries(value)) {
      const kind = fields[key];
      if (kind === undefined) throw new ChromeConfigError(`chrome: unknown setting "${section}.${key}"; expected one of ${Object.keys(fields).join(", ")}`);
      check(kind, field, `${section}.${key}`);
      result[section]![key] = field;
    }
  }
  const chrome = result as unknown as ChromeConfig;
  if (chrome.product.name.trim() === "") throw new ChromeConfigError("chrome: product.name must not be empty");
  return chrome;
}

/** What the browser half needs: no file paths, no stylesheet text. */
export interface BrowserChrome {
  product: ChromeConfig["product"];
  splash: { wordmark: string; hint: string };
  welcome: ChromeConfig["welcome"];
  version: { show: boolean; label: string };
  /** Page-relative URLs (the page sets `<base href="./">`). */
  assets: { logo: string; logoDark: string };
}

export function browserChrome(chrome: ChromeConfig, versionLabel: string): BrowserChrome {
  return {
    product: chrome.product,
    splash: { wordmark: chrome.splash.wordmark ?? chrome.product.name, hint: chrome.splash.hint },
    welcome: chrome.welcome,
    version: { show: chrome.version.show, label: versionLabel },
    assets: { logo: `${ASSET_ROUTE.slice(1)}/logo`, logoDark: `${ASSET_ROUTE.slice(1)}/logo-dark` },
  };
}

/** Route prefix under which the host serves brand assets. */
export const ASSET_ROUTE = "/tack-chrome";
