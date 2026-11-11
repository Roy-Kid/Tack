/**
 * Hide registered tools from agents. The supervising compositions use it so
 * their agent cannot edit files itself: it delegates. Rows that can be
 * switched off whole are left out instead; this covers tools that share a row
 * with ones the agent keeps (`write` and `edit` register with `read`).
 */
export const name = "tack-tool-mask";

export interface ToolMaskConfig {
  /** Tool names hidden from the agent; names the agent cannot see are ignored. */
  deny?: string[];
}

interface AgentLike {
  ctx: { tools: { restrict(filter: { deny: readonly string[] }): () => void } };
}

interface MaskContext {
  on(event: "agent/created", listener: (event: { agent: AgentLike }) => void): () => void;
}

export function apply(ctx: MaskContext, config: ToolMaskConfig = {}): void {
  const deny = [...new Set(config.deny ?? [])];
  if (deny.length === 0) return;
  ctx.on("agent/created", ({ agent }) => {
    // Restrict names separately because a tool the agent cannot see fails the call.
    for (const tool of deny) {
      try {
        agent.ctx.tools.restrict({ deny: [tool] });
      } catch {
        // Not a tool this agent sees.
      }
    }
  });
}
