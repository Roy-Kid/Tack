/**
 * `tack-molvis`: MolVis as a Tack capability.
 *
 * `molvis_stage` opens a structure in the 3D stage. `molvis_sketch` draws a
 * 2D formula. Both return the page MolVis prints. The drawing is MolVis's.
 */
import { cliHost, type RunningView, STAGE_STYLES, type StageStyle, type ViewHost, type ViewRequest } from "./session.js";

export const name = "tack-molvis";
export const inject = ["tools"];

export interface MolvisTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: typeof viewOutput;
  execute(args: unknown): Promise<{ text: string; meta: { url: string; command: string; target: string } }>;
}

interface ToolContext {
  tools: { register(definition: unknown): (() => void) | void };
  effect?(execute: () => () => void): void;
}

const viewOutput = {
  schema: { type: "object", properties: { text: { type: "string" }, meta: { type: "object", additionalProperties: true } }, required: ["text", "meta"], additionalProperties: false },
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: (value as { text: string }).text }],
  presentationMeta: (_args: unknown, value: unknown) => (value as { meta: Record<string, unknown> }).meta,
};

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requestOf(command: ViewRequest["command"], args: unknown): ViewRequest {
  const target = stringArg(args, command === "stage" ? "file" : "molecule");
  if (target === undefined) throw new Error(command === "stage" ? "molvis_stage needs a structure file" : "molvis_sketch needs a file or a SMILES string");
  const style = stringArg(args, "style");
  if (style !== undefined && !STAGE_STYLES.includes(style as StageStyle)) throw new Error(`molvis_stage style must be one of ${STAGE_STYLES.join(", ")}`);
  return { command, target, ...(stringArg(args, "name") !== undefined && { name: stringArg(args, "name") }), ...(style !== undefined && { style: style as StageStyle }) };
}

async function open(host: ViewHost, request: ViewRequest): Promise<{ text: string; meta: { url: string; command: string; target: string } }> {
  const view: RunningView = await host.open(request);
  const kind = request.command === "stage" ? "3D stage" : "2D board";
  return {
    text: `MolVis ${kind} is at ${view.url}. Use this live page during the session; a saved research report cites the registered asset instead. Do not redraw the molecule.`,
    meta: { url: view.url, command: request.command, target: request.target },
  };
}

/** The two tools, over a host so a test can open a view without spawning MolVis. */
export function molvisTools(host: ViewHost): MolvisTool[] {
  return [
    {
      name: "molvis_stage",
      output: viewOutput,
      description: "Open a structure or trajectory in MolVis's 3D stage and return the live page url. A static structure is framed after the page connects. Use that url during the session; saved reports cite registered assets. Do not draw the molecule another way.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Structure file MolVis reads (.pdb, .xyz, .mol2, .sdf, and the other formats `molvis stage` lists)." },
          name: { type: "string", description: "Stage name. A second call with the same name is still a new page." },
          style: { type: "string", enum: [...STAGE_STYLES], description: "Rendering style. Default ball-and-stick." },
        },
        required: ["file"],
        additionalProperties: false,
      },
      execute: async (args) => open(host, requestOf("stage", args)),
    },
    {
      name: "molvis_sketch",
      output: viewOutput,
      description: "Draw one molecule on MolVis's 2D formula board. `molecule` is a file or a SMILES string (bonding descriptors such as [<] mark ports). Returns the live page url.",
      parameters: {
        type: "object",
        properties: {
          molecule: { type: "string", description: "A structure file, or a SMILES string." },
          name: { type: "string", description: "Board name." },
        },
        required: ["molecule"],
        additionalProperties: false,
      },
      execute: async (args) => open(host, requestOf("sketch", args)),
    },
  ];
}

export function apply(ctx: ToolContext): void {
  const host = cliHost(process.env.MOLVIS_BIN?.trim() || "molvis");
  const dispose: ((() => void) | void)[] = [];
  const stop = () => {
    host.close();
    for (const undo of dispose) undo?.();
  };
  if (ctx.effect !== undefined) ctx.effect(() => stop);
  try {
    for (const tool of molvisTools(host)) dispose.push(ctx.tools.register(tool));
  } catch (error) {
    stop();
    throw error;
  }
}
