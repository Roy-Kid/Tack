/**
 * Hide registered tools from agents. The supervising compositions use it so
 * their agent cannot edit files itself: it delegates. Rows that can be
 * switched off whole are left out instead; this covers tools that share a row
 * with ones the agent keeps (`write` and `edit` register with `read`).
 *
 * Without `preset`, every agent the profile creates is masked (the headless
 * `supervise` profile). With `preset`, only agents composed from that agent
 * preset are (the web profile's Supervise preset); a blank session that
 * switches preset is re-evaluated.
 */
export const name = "tack-tool-mask";

export interface ToolMaskConfig {
  /** Tool names hidden from the agent; names the agent cannot see are ignored. */
  deny?: string[];
  /** Mask only agents composed from this agent preset. */
  preset?: string;
}

interface AgentLike {
  ctx: { tools: { restrict(filter: { deny: readonly string[] }): () => void } };
  session: { id: string };
}

interface MaskContext {
  /** Reads a service when present; the agent preset registry exists only in preset compositions. */
  get(name: "agentPresets"): { composedPreset(ctx: unknown): string | undefined } | undefined;
  on(event: "agent/created", listener: (event: { agent: AgentLike }) => void): () => void;
  on(event: "agent/disposed", listener: (event: { agent: AgentLike }) => void): () => void;
  on(event: "agent-preset/selected", listener: (sessionId: string, preset: string) => void): () => void;
}

/** Restrict each name the agent can see; one restriction per name, since an unseen name fails the call. */
export function maskAgent(agent: AgentLike, deny: readonly string[]): () => void {
  const lifts: (() => void)[] = [];
  for (const tool of deny) {
    try {
      lifts.push(agent.ctx.tools.restrict({ deny: [tool] }));
    } catch {
      // Not a tool this agent sees.
    }
  }
  return () => {
    for (const lift of lifts.splice(0)) lift();
  };
}

export function apply(ctx: MaskContext, config: ToolMaskConfig = {}): void {
  const deny = [...new Set(config.deny ?? [])];
  if (deny.length === 0) return;
  const preset = config.preset;
  const agents = new Map<string, { agent: AgentLike; lift?: () => void }>();

  const evaluate = (entry: { agent: AgentLike; lift?: () => void }, selected?: string) => {
    const current = preset === undefined ? undefined : (selected ?? ctx.get("agentPresets")?.composedPreset(entry.agent.ctx));
    const wanted = preset === undefined || current === preset;
    if (wanted && entry.lift === undefined) entry.lift = maskAgent(entry.agent, deny);
    else if (!wanted && entry.lift !== undefined) {
      entry.lift();
      entry.lift = undefined;
    }
  };

  ctx.on("agent/created", ({ agent }) => {
    const entry = { agent };
    agents.set(agent.session.id, entry);
    evaluate(entry);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    agents.delete(agent.session.id);
  });
  if (preset !== undefined) {
    ctx.on("agent-preset/selected", (sessionId, selected) => {
      const entry = agents.get(sessionId);
      if (entry !== undefined) evaluate(entry, selected);
    });
  }
}
