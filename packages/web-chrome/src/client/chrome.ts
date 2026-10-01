/** The browser settings the host half publishes into the page. */
import type { BrowserChrome } from "../host/config.js";

export type { BrowserChrome };

export function readChrome(): BrowserChrome {
  const value = (globalThis as { __TACK_CHROME__?: BrowserChrome }).__TACK_CHROME__;
  if (value === undefined) throw new Error("tack-web-chrome: page settings are missing; is the tack-web-chrome host row enabled?");
  return value;
}
