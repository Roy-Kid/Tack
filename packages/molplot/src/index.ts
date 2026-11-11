/**
 * `tack-molplot`: MolPlot as a Tack capability.
 *
 * `molplot_chart` asks MolPlot for a Vega-Lite spec and serves it as a
 * `<molplot-chart>` page (pan and zoom are MolPlot's). `molplot_serve`
 * opens MolPlot's figure workbench on a Python script.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  assertChart,
  type BarSeries,
  type ChartRequest,
  chartPage,
  type FigureServer,
  type LineSeries,
  molplotDist,
  molplotPython,
  pythonRunner,
  serveFigures,
  type SpecRunner,
} from "./chart.js";

export const name = "tack-molplot";
export const inject = ["tools"];

export interface MolplotTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: typeof chartOutput;
  execute(args: unknown): Promise<{ text: string; meta: Record<string, unknown> }>;
}

interface ToolContext {
  tools: { register(definition: unknown): (() => void) | void };
  effect?(execute: () => () => void | Promise<void>): void;
}

const chartOutput = {
  schema: { type: "object", properties: { text: { type: "string" }, meta: { type: "object", additionalProperties: true } }, required: ["text", "meta"], additionalProperties: false },
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: (value as { text: string }).text }],
  presentationMeta: (_args: unknown, value: unknown) => (value as { meta: Record<string, unknown> }).meta,
};

const seriesSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    values: { type: "array", items: { type: "number" } },
    x: { type: "array", items: { type: "number" } },
    y: { type: "array", items: { type: "number" } },
    color: { type: "string" },
  },
  required: ["id"],
};

function requestOf(args: unknown): ChartRequest & { name?: string } {
  if (typeof args !== "object" || args === null) throw new Error("molplot_chart needs a chart request");
  const raw = args as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : "";
  const kind = raw.kind;
  const xLabel = typeof raw.xLabel === "string" ? raw.xLabel : undefined;
  const yLabel = typeof raw.yLabel === "string" ? raw.yLabel : undefined;
  const labels = { ...(xLabel !== undefined && { xLabel }), ...(yLabel !== undefined && { yLabel }) };
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;
  if (kind === "bar") {
    const request: ChartRequest = { kind, title, categories: stringList(raw.categories), series: barSeries(raw.series), ...labels };
    assertChart(request);
    return { ...request, ...(name !== undefined && { name }) };
  }
  if (kind === "line") {
    const request: ChartRequest = { kind, title, series: lineSeries(raw.series), ...labels };
    assertChart(request);
    return { ...request, ...(name !== undefined && { name }) };
  }
  if (kind === "scatter") {
    const request: ChartRequest = { kind, title, x: numberList(raw.x), y: numberList(raw.y), ...labels };
    assertChart(request);
    return { ...request, ...(name !== undefined && { name }) };
  }
  throw new Error("molplot_chart kind must be bar, line, or scatter");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("categories must be strings");
  return value;
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("x and y must be numbers");
  return value;
}

function barSeries(value: unknown): BarSeries[] {
  if (!Array.isArray(value)) throw new Error("series must be a list");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("a series is an object");
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string") throw new Error("a series needs an id");
    return {
      id: row.id,
      values: numberList(row.values),
      ...(typeof row.label === "string" && { label: row.label }),
      ...(typeof row.color === "string" && { color: row.color }),
    };
  });
}

function lineSeries(value: unknown): LineSeries[] {
  if (!Array.isArray(value)) throw new Error("series must be a list");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("a series is an object");
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string") throw new Error("a series needs an id");
    return {
      id: row.id,
      x: numberList(row.x),
      y: numberList(row.y),
      ...(typeof row.label === "string" && { label: row.label }),
      ...(typeof row.color === "string" && { color: row.color }),
    };
  });
}

function slug(name: string | undefined, title: string): string {
  const base = (name ?? title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base === "" ? "chart" : base}.html`;
}

export interface ChartDeps {
  runner: SpecRunner;
  server: FigureServer;
}

/** Chart and workbench tools. A test injects the runner, the server, and the workbench. */
export function molplotTools(deps: ChartDeps, workbench: (script: string, port: number) => Promise<string> = startWorkbench): MolplotTool[] {
  return [
    {
      name: "molplot_chart",
      output: chartOutput,
      description: "Build one interactive chart with MolPlot (bar, line, or scatter) and return its page url. Use this live page during the session; a saved research report cites the registered asset instead. Do not draw the chart another way. Numbers the source says are not comparable stay in a table, not on one shared axis.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bar", "line", "scatter"] },
          title: { type: "string" },
          name: { type: "string", description: "File name stem for the page. Default is the title." },
          categories: { type: "array", items: { type: "string" }, description: "Bar categories." },
          series: { type: "array", items: seriesSchema, description: "Bar series use values. Line series use x and y." },
          x: { type: "array", items: { type: "number" } },
          y: { type: "array", items: { type: "number" } },
          xLabel: { type: "string" },
          yLabel: { type: "string" },
        },
        required: ["kind", "title"],
        additionalProperties: false,
      },
      async execute(args) {
        const request = requestOf(args);
        const spec = await deps.runner.spec(request);
        const url = deps.server.publish(slug(request.name, request.title), chartPage(request.title, spec));
        return { text: `MolPlot chart is at ${url}. Use this live page during the session; a saved research report cites the registered asset instead.`, meta: { url, kind: request.kind, title: request.title } };
      },
    },
    {
      name: "molplot_serve",
      output: chartOutput,
      description: "Open MolPlot's interactive figure workbench on a Python script that builds figures (assign fig, figure, or figs, or call pyplot). Returns the workbench url. Default port is 8772, not 8765.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "Python file MolPlot serves." },
          port: { type: "number", description: "Workbench port. Default 8772." },
        },
        required: ["script"],
        additionalProperties: false,
      },
      async execute(args) {
        if (typeof args !== "object" || args === null) throw new Error("molplot_serve needs a script");
        const script = (args as { script?: unknown }).script;
        if (typeof script !== "string" || script.trim() === "") throw new Error("molplot_serve needs a script");
        const port = (args as { port?: unknown }).port;
        const url = await workbench(script, typeof port === "number" ? port : 8772);
        return { text: `MolPlot workbench is at ${url}.`, meta: { url, script } };
      },
    },
  ];
}

const benches: ChildProcess[] = [];

/** `molplot serve --no-open`. Resolves when MolPlot prints its url. */
export function startWorkbench(script: string, port: number, bin = process.env.MOLPLOT_BIN?.trim() || "molplot"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["serve", script, "--host", "127.0.0.1", "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
    benches.push(child);
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`molplot: workbench did not print a url\n${text}`));
    }, 30_000);
    const take = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const match = /MolPlot\s+(http:\/\/\S+)/.exec(text);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1].replace(/\/$/, ""));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`molplot: workbench exited ${code ?? "unknown"}\n${text}`));
    });
  });
}

export function stopWorkbenches(): void {
  for (const child of benches.splice(0)) child.kill("SIGTERM");
}

export function apply(ctx: ToolContext): void {
  let figures: FigureServer | undefined;
  let runner: SpecRunner | undefined;
  let ready: Promise<void> | undefined;
  let stopped = false;
  const dispose: ((() => void) | void)[] = [];
  const server: FigureServer = {
    url: "",
    publish(name, html) {
      if (figures === undefined) throw new Error("molplot: the chart server is not up yet");
      return figures.publish(name, html);
    },
    close: () => figures?.close() ?? Promise.resolve(),
  };
  const [chart, workbench] = molplotTools({ runner: { spec: (request) => {
    if (runner === undefined) throw new Error("molplot: chart runner is not ready");
    return runner.spec(request);
  } }, server });
  if (chart === undefined || workbench === undefined) return;
  const stop = async () => {
    stopped = true;
    stopWorkbenches();
    for (const undo of dispose) undo?.();
    // A server that finishes starting after disposal must be closed as well.
    await ready?.catch(() => {});
    await figures?.close();
  };
  if (ctx.effect !== undefined) ctx.effect(() => stop);
  try {
    dispose.push(ctx.tools.register({ ...chart, execute: async (args: unknown) => {
      if (stopped) throw new Error("molplot: plugin is closed");
      ready ??= (async () => {
        const python = molplotPython();
        runner = pythonRunner(python);
        figures = await serveFigures(await molplotDist(python), Number(process.env.MOLPLOT_PORT ?? 8771));
      })();
      await ready;
      if (stopped) throw new Error("molplot: plugin is closed");
      return chart.execute(args);
    } }));
    dispose.push(ctx.tools.register(workbench));
  } catch (error) {
    void stop();
    throw error;
  }
}
