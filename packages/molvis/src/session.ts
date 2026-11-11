/**
 * MolVis's own page. `molvis stage --preview` and `molvis sketch --preview`
 * print `molvis: the page is at <url>` and serve a read-only page: reset view
 * and download, the structure framed, sent again to every page that attaches,
 * so a report reader can reload it. This module starts that process and reads
 * the url. It does not draw.
 */
import { type ChildProcess, spawn } from "node:child_process";

const PAGE = /molvis: the page is at (\S+)/;

export const STAGE_STYLES = [
  "ball-and-stick",
  "flat",
  "ball-and-tube",
  "tube",
  "metal-tube",
  "wireframe",
  "bubble",
  "spacefill",
  "skeletal",
  "graph",
] as const;

export type StageStyle = (typeof STAGE_STYLES)[number];

export interface ViewRequest {
  command: "stage" | "sketch";
  target: string;
  name?: string;
  style?: StageStyle;
}

/**
 * Arguments for one `molvis` invocation: a read-only preview, light like the
 * MolPlot chart pages. MolVis opens no browser for a preview.
 */
export function viewArgs(request: ViewRequest): string[] {
  const args = [request.command, "--preview", "--theme", "light"];
  if (request.name !== undefined && request.name !== "") args.push("--name", request.name);
  if (request.command === "stage" && request.style !== undefined) args.push("--style", request.style);
  args.push(request.target);
  return args;
}

/** The page url MolVis printed, if the line is in `text`. */
export function pageUrlFrom(text: string): string | undefined {
  return PAGE.exec(text)?.[1];
}

export interface RunningView {
  url: string;
  close(): void;
}

export interface ViewHost {
  open(request: ViewRequest): Promise<RunningView>;
}

/** Read stdout and stderr until MolVis prints its page url, or the process exits. */
export function watchPage(child: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`molvis: no page url after ${timeoutMs}ms\n${text}`));
    }, timeoutMs);
    const take = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const url = pageUrlFrom(text);
      if (url === undefined) return;
      clearTimeout(timer);
      resolve(url);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (pageUrlFrom(text) === undefined) reject(new Error(`molvis: exited ${code ?? "unknown"} before printing a page\n${text}`));
    });
  });
}

/** One live MolVis process per call. Closing it stops the page. */
export function cliHost(bin = process.env.MOLVIS_BIN?.trim() || "molvis"): ViewHost & { close(): void } {
  const children: ChildProcess[] = [];
  return {
    async open(request) {
      const child = spawn(bin, viewArgs(request), { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      const url = await watchPage(child);
      return { url, close: () => child.kill("SIGTERM") };
    },
    close() {
      for (const child of children) child.kill("SIGTERM");
    },
  };
}

