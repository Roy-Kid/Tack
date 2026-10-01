/**
 * Read an integrator's chrome JSON file into row settings: relative paths are
 * resolved against the file, and the Tailwind theme and custom CSS files are
 * read into stylesheet text. Only the Tack CLI calls this.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ChromeConfigError, resolveChrome, type ChromeConfig } from "./config.js";

export function loadChromeFile(file: string): ChromeConfig {
  const path = resolve(file);
  if (!existsSync(path)) throw new ChromeConfigError(`chrome: ${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ChromeConfigError(`chrome: ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const chrome = resolveChrome(raw);
  const base = dirname(path);
  const locate = (value: string | null, key: string): string | null => {
    if (value === null) return null;
    const target = isAbsolute(value) ? value : resolve(base, value);
    if (!existsSync(target)) throw new ChromeConfigError(`chrome: ${key} points at ${target}, which does not exist`);
    return target;
  };
  for (const key of ["logo", "logoDark", "favicon", "faviconDark"] as const) chrome.brand[key] = locate(chrome.brand[key], `brand.${key}`);
  const cssPath = locate(chrome.theme.css, "theme.css");
  const customPath = locate(chrome.theme.customCss, "theme.customCss");
  chrome.theme.css = cssPath === null ? null : readFileSync(cssPath, "utf8");
  chrome.theme.customCss = customPath === null ? null : readFileSync(customPath, "utf8");
  if (cssPath !== null && chrome.theme.source === "theme") chrome.theme.source = basename(cssPath);
  return chrome;
}
