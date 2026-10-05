/**
 * Hide registered tools from every agent a profile creates. Used by the
 * `supervise` profile so its agent cannot edit files itself: it delegates.
 * Rows that can be switched off whole are disabled in the bundle instead; this
 * covers tools that share a row with ones the agent keeps (`write` and `edit`
 * register with `read`).
 */
export const name = "tack-tool-mask";
export const inject = ["tools"];

export interface ToolMaskConfig {
  /** Tool names hidden from every agent; names no row registered are ignored. */
  deny?: string[];
}

interface ToolsLike {
  schemas(): { name: string }[];
  restrict(filter: { deny: readonly string[] }): () => void;
}

interface MaskContext {
  tools: ToolsLike;
  on(event: "agent/created", listener: (event: { agent: { ctx: { tools: ToolsLike } } }) => void): () => void;
}

export function apply(ctx: MaskContext, config: ToolMaskConfig = {}): void {
  const deny = [...new Set(config.deny ?? [])];
  if (deny.length === 0) return;
  ctx.on("agent/created", ({ agent }) => {
    const registered = new Set(ctx.tools.schemas().map((schema) => schema.name));
    const present = deny.filter((tool) => registered.has(tool));
    if (present.length > 0) agent.ctx.tools.restrict({ deny: present });
  });
}
