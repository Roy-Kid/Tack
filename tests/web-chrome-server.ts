/** Serve `tack web` with a chrome file and hold an authenticated session for fetches. */
import { type RunningTack, spawnTackUntil } from "./helpers.js";

export interface ChromeServer {
  running: RunningTack;
  /** The one-time URL Tack printed (carries the token). */
  url: string;
  /** Page base URL, with trailing slash. */
  base: string;
  /** Fetch a page-relative path with the session cookie. */
  get(path: string): Promise<Response>;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export async function serveChrome(home: string, extraArgs: readonly string[]): Promise<ChromeServer> {
  const running = await spawnTackUntil(["web", ...extraArgs, "--no-open", "--port", "0"], {
    home,
    pattern: /https?:\/\/127\.0\.0\.1:\d+\//,
    timeoutMs: 90_000,
  });
  const url = /https?:\/\/127\.0\.0\.1:\d+\/\S*/.exec(running.matched)![0];
  const base = `${new URL(url).origin}/`;
  let cookie = "";
  const exchange = await fetch(url, { redirect: "manual" });
  cookie = (exchange.headers.getSetCookie()[0] ?? "").split(";")[0]!;
  return {
    running,
    url,
    base,
    get: (path) => fetch(new URL(path, base), { headers: { cookie } }),
    stop: async () => {
      running.child.kill("SIGINT");
      return await Promise.race([
        running.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("did not exit within 10s of SIGINT")), 10_000)),
      ]);
    },
  };
}
