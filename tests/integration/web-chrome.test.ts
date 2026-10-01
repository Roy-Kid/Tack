/**
 * `tack web` chrome: an integrator's settings file (name, brand, Tailwind 4
 * theme) reaches the served page, and Tack's own chrome is the default.
 * Asserts what Tack serves; never the runtime's own wording.
 */
import { beforeAll, describe, expect, it } from "@rstest/core";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, parseDumpRows, REPO_ROOT, spawnTack, tempHome } from "../helpers.js";
import { serveChrome } from "../web-chrome-server.js";

const EXAMPLE = join(REPO_ROOT, "examples", "web-chrome");
const CHROME_FILE = join(EXAMPLE, "chrome.json");
const example = JSON.parse(readFileSync(CHROME_FILE, "utf8")) as { product: { name: string; shortName: string } };
const pageGlobal = (html: string, name: string): unknown => {
  const match = new RegExp(`\\[${JSON.stringify(name).replace(/[[\]\\]/g, "\\$&")}\\]\\s*=\\s*(\\{.*?\\});?\\s*</script>`, "s").exec(html);
  return match === null ? undefined : JSON.parse(match[1]!);
};

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`built bin missing at ${BIN}; run npm run build first`);
});

describe("tack web --chrome --check", () => {
  it("validates the settings and prints them with the compiled theme", async () => {
    const home = tempHome();
    const result = await spawnTack(["web", "--chrome", CHROME_FILE, "--check"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(example.product.name);
    expect(result.stdout).toContain(join(EXAMPLE, "logo.svg"));
    expect(result.stdout).toMatch(/--dsw-alias-bg-base: var\(--color-background\)/);
    expect(existsSync(join(home, "profiles"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("uses $TACK_HOME/web-chrome.json when no file is given", async () => {
    const home = tempHome();
    writeFileSync(join(home, "web-chrome.json"), JSON.stringify({ product: { name: "Home Brand" } }));
    const result = await spawnTack(["web", "--check"], { home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Home Brand");
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 1 naming the problem for a bad file", async () => {
    const home = tempHome();
    const bad = join(home, "bad.json");
    writeFileSync(bad, JSON.stringify({ product: { title: "x" } }));
    for (const file of [bad, join(home, "missing.json")]) {
      const result = await spawnTack(["web", "--chrome", file, "--check"], { home });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/product\.title|does not exist/);
    }
    const serve = await spawnTack(["web", "--chrome", bad, "--no-open", "--port", "0"], { home });
    expect(serve.code).toBe(1);
    expect(serve.stderr).toContain("product.title");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("tack web chrome", () => {
  it("composes the chrome row into the web profile", async () => {
    const home = tempHome();
    const result = await spawnTack(["doctor", "--profile", "web", "--dump-config"], { home });
    expect(result.code).toBe(0);
    const row = parseDumpRows(result.stdout).find((entry) => entry.id === "tack-web-chrome");
    expect(row?.name).toBe("@tack/web-chrome");
    expect(row?.disabled).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("serves the integrator's name, theme, icons, manifest, and logo", async () => {
    const home = tempHome();
    const server = await serveChrome(home, ["--chrome", CHROME_FILE]);
    try {
      const index = await server.get("./");
      expect(index.status).toBe(200);
      const html = await index.text();
      expect(html).toContain(`<title>${example.product.name}</title>`);
      expect((pageGlobal(html, "__TACK_CHROME__") as { product: { name: string } }).product.name).toBe(example.product.name);
      expect(html).toContain("--dsw-alias-bg-base: var(--color-background)");
      expect(html).toContain("oklch(0.985 0.004 95)");
      const links = [...html.matchAll(/<link\b[^>]*rel="(icon|manifest)"[^>]*href="([^"]*)"/g)].map((m) => m[2]);
      expect(links.length).toBe(3);
      expect(links.every((href) => href!.startsWith("tack-chrome/"))).toBe(true);

      const manifest = (await (await server.get("tack-chrome/manifest.webmanifest")).json()) as { name: string; short_name: string };
      expect(manifest).toMatchObject({ name: example.product.name, short_name: example.product.shortName });

      const logo = await server.get("tack-chrome/logo");
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      expect(await logo.text()).toBe(readFileSync(join(EXAMPLE, "logo.svg"), "utf8"));
      expect(await (await server.get("tack-chrome/logo-dark")).text()).toBe(readFileSync(join(EXAMPLE, "logo-dark.svg"), "utf8"));
      expect((await server.get("tack-chrome/unknown")).status).toBe(404);
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves Tack's own chrome by default", async () => {
    const home = tempHome();
    const server = await serveChrome(home, []);
    try {
      const html = await (await server.get("./")).text();
      expect(html).toContain("<title>Tack</title>");
      const builtIn = readFileSync(join(REPO_ROOT, "packages", "web-chrome", "assets", "tack-mark.svg"), "utf8");
      expect(await (await server.get("tack-chrome/favicon")).text()).toBe(builtIn);
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
