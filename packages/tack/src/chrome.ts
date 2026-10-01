/**
 * Web chrome settings for `tack web`: which file applies, and the `--check`
 * report. The file shape and its validation belong to @tack/web-chrome.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ChromeConfigError, type ChromeConfig } from "@tack/web-chrome/config";
import { loadChromeFile } from "@tack/web-chrome/file";
import { compileTheme } from "@tack/web-chrome/theme";

export const HOME_CHROME_FILE = "web-chrome.json";

/** `--chrome <file>` wins; otherwise `$TACK_HOME/web-chrome.json` when present; otherwise none. */
export function chromeSource(tackHome: string, flag: string | undefined): string | undefined {
  if (flag !== undefined) return flag;
  const home = join(tackHome, HOME_CHROME_FILE);
  return existsSync(home) ? home : undefined;
}

export function loadChrome(file: string): ChromeConfig {
  return loadChromeFile(file);
}

/** The integrator's dry run: resolved settings (stylesheets summarised) and the compiled theme. */
export function chromeReport(file: string | undefined, chrome: ChromeConfig): string {
  const theme = compileTheme(chrome.theme.css ?? undefined, chrome.theme.customCss ?? undefined, chrome.theme.source);
  const summary = {
    ...chrome,
    theme: {
      ...chrome.theme,
      css: chrome.theme.css === null ? null : `<${chrome.theme.css.length} chars>`,
      customCss: chrome.theme.customCss === null ? null : `<${chrome.theme.customCss.length} chars>`,
    },
  };
  return [
    `# chrome: ${file ?? "built-in defaults"}`,
    JSON.stringify(summary, null, 2),
    "",
    `# theme: ${theme.mapped.length} runtime tokens mapped, ${theme.passthrough.length} passed through`,
    theme.css,
  ].join("\n");
}

export function isChromeConfigError(error: unknown): error is Error {
  return error instanceof ChromeConfigError;
}
