/**
 * MolPlot charts. The spec is built by MolPlot's Python (`bar_spec`,
 * `line_spec`, `scatter_spec`). The page is MolPlot's `<molplot-chart>`
 * element, which pans and zooms. This module does not draw the marks.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export interface BarSeries {
  id: string;
  label?: string;
  values: number[];
  color?: string;
}

export interface LineSeries {
  id: string;
  label?: string;
  x: number[];
  y: number[];
  color?: string;
}

export type ChartRequest =
  | { kind: "bar"; title: string; categories: string[]; series: BarSeries[]; xLabel?: string; yLabel?: string }
  | { kind: "line"; title: string; series: LineSeries[]; xLabel?: string; yLabel?: string }
  | { kind: "scatter"; title: string; x: number[]; y: number[]; xLabel?: string; yLabel?: string };

/** The program MolPlot runs. It reads one JSON request and writes one Vega-Lite spec. */
export const SPEC_PROGRAM = `
import json, sys
import molplot
req = json.load(sys.stdin)
kind = req["kind"]
preset = "molplot-paper"
if kind == "bar":
    spec = molplot.bar_spec(req["categories"], req["series"], x_label=req.get("xLabel"), y_label=req.get("yLabel"), show_legend=True, preset=preset, mode="light", height=320)
elif kind == "line":
    spec = molplot.line_spec(req["series"], x_label=req.get("xLabel"), y_label=req.get("yLabel"), show_legend=True, preset=preset, mode="light", height=320)
elif kind == "scatter":
    spec = molplot.scatter_spec(req["x"], req["y"], x_label=req.get("xLabel"), y_label=req.get("yLabel"), preset=preset, mode="light", height=320)
else:
    raise SystemExit("unknown chart kind")
json.dump(spec, sys.stdout)
`;

export function assertChart(request: ChartRequest): void {
  if (request.title.trim() === "") throw new Error("molplot_chart needs a title");
  if (request.kind === "bar") {
    if (request.categories.length === 0 || request.series.length === 0) throw new Error("a bar chart needs categories and one series");
    for (const series of request.series) {
      if (series.values.length !== request.categories.length) throw new Error(`series ${series.id} has ${series.values.length} values for ${request.categories.length} categories`);
    }
  } else if (request.kind === "line") {
    if (request.series.length === 0) throw new Error("a line chart needs one series");
    for (const series of request.series) {
      if (series.x.length !== series.y.length || series.x.length === 0) throw new Error(`series ${series.id} needs equal, non-empty x and y`);
    }
  } else if (request.x.length !== request.y.length || request.x.length === 0) {
    throw new Error("a scatter chart needs equal, non-empty x and y");
  }
}

/**
 * One chart page. The element and its assets come from MolPlot; the spec is
 * the only data. The page is a read-only preview. The element sizes itself to
 * the page, so the page does not style it.
 */
export function chartPage(title: string, spec: unknown): string {
  const json = JSON.stringify(spec);
  const label = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${label}</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
</style>
</head>
<body>
<molplot-chart mode="readonly" label="${label}" preset="molplot-paper" theme="light">
<script type="application/json">
${json}
</script>
</molplot-chart>
<script type="module" src="/vendor/elements.js"></script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SpecRunner {
  spec(request: ChartRequest): Promise<unknown>;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

export interface FigureServer {
  url: string;
  publish(name: string, html: string): string;
  close(): Promise<void>;
}

/** Serve chart pages and MolPlot's element bundle on one origin, so the module script loads. */
export function serveFigures(assetsDir: string, port: number): Promise<FigureServer> {
  if (!existsSync(join(assetsDir, "elements.js"))) throw new Error(`molplot: elements.js is not in ${assetsDir}. Set MOLPLOT_DIST to MolPlot's core/dist.`);
  const pages = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/vendor/")) {
      const root = normalize(assetsDir);
      const file = normalize(join(root, path.slice("/vendor/".length)));
      const inside = file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
      if (!inside || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    const name = path.replace(/^\//, "");
    const html = pages.get(name);
    if (html === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        publish(name, html) {
          pages.set(name, html);
          return `http://127.0.0.1:${bound}/${name}`;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Run MolPlot's spec builders with the given Python. */
export function pythonRunner(python: string): SpecRunner {
  return {
    spec(request) {
      assertChart(request);
      return new Promise((resolve, reject) => {
        const child = spawn(python, ["-c", SPEC_PROGRAM], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`molplot: spec builder exited ${code ?? "unknown"}\n${err}`));
          else {
            try { resolve(JSON.parse(out) as unknown); }
            catch (error) { reject(new Error(`molplot: spec was not JSON\n${out}\n${error instanceof Error ? error.message : String(error)}`)); }
          }
        });
        child.stdin.end(JSON.stringify(request));
      });
    },
  };
}

const DIST_PROGRAM = `
import os, pathlib
import molplot
set = os.environ.get("MOLPLOT_DIST", "").strip()
path = pathlib.Path(set) if set else pathlib.Path(molplot.__file__).resolve().parents[3] / "core" / "dist"
print(path)
`;

/** Directory that holds MolPlot's `elements.js`, from MOLPLOT_DIST or the source checkout next to the Python package. */
export function molplotDist(python: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", DIST_PROGRAM], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`molplot: could not locate its web bundle\n${err}`));
      else resolve(out.trim());
    });
  });
}

/** Configured Python, else the interpreter of MolPlot or the installed Molab CLI. */
export function molplotPython(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.MOLPLOT_PYTHON?.trim();
  if (set !== undefined && set !== "") return set;
  for (const bin of env.MOLPLOT_BIN?.trim() ? [env.MOLPLOT_BIN.trim()] : ["molplot", "molab"]) {
    try {
      const first = readFileSync(spawnSyncWhich(bin), "utf8").split("\n")[0] ?? "";
      if (first.startsWith("#!")) return first.slice(2).trim();
    } catch {
      // The next installed scientific CLI may identify the shared Python.
    }
  }
  throw new Error("molplot: set MOLPLOT_PYTHON to a Python that imports molplot, or install the molplot CLI");
}

function spawnSyncWhich(bin: string): string {
  return execFileSync("which", [bin], { encoding: "utf8" }).trim();
}
