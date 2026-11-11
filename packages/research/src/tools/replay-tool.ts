/** Read the scientific journey, including failures and recovery, without executing it. */
import type { ReplayQuery } from "../molab/schemas.js";
import { clipJson, type ResearchDeps, type ToolSpec } from "./types.js";

export function researchReplay(deps: ResearchDeps): ToolSpec<Partial<ReplayQuery> & { document?: string; commit?: string }> {
  return {
    name: "research_replay",
    description: "Replay the research journey oldest first: experiments, parameters, attempts, failures, resumes, products and versioned knowledge. Read-only: never reruns compute or records approvals. Use nextOffset with asOf for the next page; document+commit identify the exact historical plan/report version.",
    parameters: {
      projectId: { type: "string" }, experimentId: { type: "string" }, runId: { type: "string" },
      kind: { type: "string", enum: ["experiment", "run", "execution", "knowledge", "asset", "history"] },
      offset: { type: "integer" }, limit: { type: "integer", description: "Events per page (1–200; default 20)." },
      asOf: { type: "string", description: "Return the previous page's asOf to keep the upper time boundary." },
      document: { type: "string", description: "Read an event's historical document instead of a timeline page; also pass its commit." },
      commit: { type: "string", description: "Full recorded commit for document." },
    },
    async execute(args, exec) {
      const { document, commit, ...query } = args;
      if (document !== undefined || commit !== undefined) {
        if (!document || !commit) throw new Error("A historical document needs both document and commit from a replay event.");
        const version = await deps.molab.replayDocument(commit, document, exec.signal);
        return { text: clipJson(version), meta: version };
      }
      const page = await deps.molab.replay({ ...query, limit: query.limit ?? 20 }, exec.signal);
      return { text: clipJson(page), meta: page };
    },
  };
}
