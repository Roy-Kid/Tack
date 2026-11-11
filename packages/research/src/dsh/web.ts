/** Research's browser API rides DSH Connection's authenticated owner routes. */
import { z } from "zod";
import { readCampaign } from "../campaign.js";
import { pendingGate } from "../delegation/model.js";
import { gateTrailer } from "../gates.js";
import { MolabError } from "../molab/client.js";
import { ReplayQuery } from "../molab/schemas.js";
import { parseRef } from "../molab/refs.js";
import { PlanWorkflow } from "../plan-workflow.js";
import { buildResearchMap, MAP_CLASSES, STATEFUL } from "../research-map.js";
import { errorMessage } from "../text.js";
import { GAPS_PATH } from "../tools/decisions.js";
import { researchPause, researchResume } from "../tools/delegation-tools.js";
import type { ResearchDeps } from "../tools/types.js";
import { callerIdentity } from "./adapter.js";

const Action = z.object({
  action: z.enum(["pause", "resume", "answer", "approve"]),
  delegation: z.string().trim().min(1),
  digest: z.string().min(1),
  answers: z.string().max(2000).default(""),
  gate: z.object({ gate: z.enum(["parameters", "plan", "dry_run", "results"]), target: z.string().min(1) }).strict().optional(),
}).strict();

/** Structural slice of DSH's Connection service; optional in headless profiles. */
export interface ResearchWebContext {
  inject(names: string[], callback: (ctx: { connection: { fetch: { register(route: {
    path: string;
    methods: ("GET" | "POST")[];
    requestBody: "buffered";
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> } }; effect(execute: () => () => Promise<void>, label?: string): void }) => void): unknown;
}

/** The name of the experiment a delegation's scope names; null for a wider scope or one Molab no longer lists. */
async function boundExperiment(deps: ResearchDeps, scope: string, signal: AbortSignal): Promise<string | null> {
  try {
    const id = parseRef(scope).experiment;
    if (id === undefined) return null;
    const projects = await deps.molab.listProjects(signal);
    const listed = await Promise.all(projects.map((project) => deps.molab.listExperiments(project.id, signal)));
    return listed.flat().find((experiment) => experiment.id === id)?.name ?? null;
  } catch {
    // The map is still worth showing without the marker.
    return null;
  }
}

/**
 * One knowledge document as a page of its own, rendered by Molab. The page is
 * sandboxed into an opaque origin, so nothing a document carries can call the
 * workbench's API as the person reading it.
 */
function documentPage(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts allow-popups", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** Read Molab directly; all mutations use the same research tools as the agent. */
export async function researchRequest(deps: ResearchDeps, request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.searchParams.has("session")) {
        const sessionId = url.searchParams.get("session")!;
        const listed = await deps.store.list(request.signal);
        const marked = listed.delegations.filter((item) => item.record.kind === "research" && item.record.supervisor.session_id === sessionId);
        const focused = deps.ledger.current(sessionId);
        const matches = marked.length > 1 && focused ? marked.filter((item) => item.path === focused) : marked;
        if (matches.length !== 1 && url.searchParams.has("binding")) return Response.json({ binding: null }, { headers });
        if (matches.length !== 1) return Response.json({ error: matches.length ? "This conversation has multiple experiment bindings. Select one through the research tools before opening its workbench." : "This conversation is not marked as an experiment." }, { status: matches.length ? 409 : 404, headers });
        const item = matches[0]!;
        if (url.searchParams.has("delegation") && url.searchParams.get("delegation") !== item.path) return Response.json({ error: "The conversation's experiment binding changed. Reopen the workbench from the conversation." }, { status: 409, headers });
        const binding = { sessionId, delegation: item.path, name: item.name, scope: item.record.scope };
        if (url.searchParams.has("binding")) return Response.json({ binding }, { headers });
        if (url.searchParams.has("map")) {
          const whole = await deps.molab.knowledgeGraph(request.signal);
          // Tack's own backlog of tool gaps is filed as a Todo, but it is an operational record, not part of the research.
          const graph = { ...whole, nodes: whole.nodes.filter((doc) => doc.relPath !== GAPS_PATH) };
          const [campaign, current] = await Promise.all([readCampaign(deps.molab, graph.nodes, request.signal), boundExperiment(deps, item.record.scope, request.signal)]);
          const stateful = graph.nodes.filter((doc) => STATEFUL[doc.cls] !== undefined);
          const read = await Promise.allSettled(stateful.map((doc) => deps.molab.getRecord(doc.relPath, request.signal)));
          // A record that cannot be read leaves the class's default; the document still appears.
          const records = Object.fromEntries(stateful.flatMap((doc, index) => { const result = read[index]!; return result.status === "fulfilled" ? [[doc.relPath, result.value.record]] : []; }));
          return Response.json({ map: buildResearchMap(graph, campaign, records), current, checkedAt: deps.now().toISOString() }, { headers });
        }
        const node = url.searchParams.get("node");
        if (node !== null) {
          const listed = await deps.molab.listDocs(request.signal);
          if (!listed.some((doc) => doc.relPath === node && MAP_CLASSES.has(doc.cls))) return Response.json({ error: "This document is not on the research map of the served workspace." }, { status: 403, headers });
          if (url.searchParams.has("page")) return documentPage((await deps.molab.docPage(node, request.signal)).html);
          return Response.json(await deps.molab.readDoc(node, request.signal), { headers });
        }
        const document = url.searchParams.get("document");
        if (document !== null) {
          if (document !== item.record.current_plan) return Response.json({ error: "This document does not belong to the conversation's current Plan." }, { status: 403, headers });
          if (url.searchParams.has("replay") && url.searchParams.has("commit")) return Response.json(await deps.molab.replayDocument(url.searchParams.get("commit")!, document, request.signal), { headers });
          return Response.json(await deps.molab.readDoc(document, request.signal), { headers });
        }
        if (url.searchParams.has("replay")) {
          const scope = parseRef(item.record.scope);
          if (!scope.experiment) return Response.json({ error: "Replay requires this conversation to be bound to a specific experiment." }, { status: 409, headers });
          const values = Object.fromEntries([...url.searchParams].filter(([key]) => !["session", "delegation", "replay"].includes(key)));
          const parsed = ReplayQuery.safeParse({ ...values, experimentId: scope.experiment, ...(scope.run && { runId: scope.run }), ...(values.offset !== undefined && { offset: Number(values.offset) }), ...(values.limit !== undefined && { limit: Number(values.limit) }) });
          if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400, headers });
          return Response.json(await deps.molab.replay(parsed.data, request.signal), { headers });
        }
        let workflow: z.infer<typeof PlanWorkflow> | null = null;
        let workflowError: string | null = null;
        let planRevision: string | null = null;
        if (item.record.current_plan) {
          const plan = await deps.molab.getRecord(item.record.current_plan, request.signal);
          if (plan.cls !== "Plan") throw new Error("The conversation's current plan is not a Plan document.");
          planRevision = plan.digest;
          if (plan.record.workflow != null) {
            const parsed = PlanWorkflow.safeParse(plan.record.workflow);
            if (parsed.success) workflow = parsed.data;
            else workflowError = "The Plan's workflow contains invalid nodes or connections. Review the Plan before loading the graph.";
          }
        }
        return Response.json({ binding, item: { ...item, gate: gateTrailer(item.path, item.record) ?? null }, planRevision, workflow, workflowError, checkedAt: deps.now().toISOString() }, { headers });
      }
      if (url.searchParams.has("replay")) {
        if (url.searchParams.has("document") && url.searchParams.has("commit")) {
          return Response.json(await deps.molab.replayDocument(url.searchParams.get("commit")!, url.searchParams.get("document")!, request.signal), { headers });
        }
        const values = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "replay"));
        const parsed = ReplayQuery.safeParse({ ...values,
          ...(values.offset !== undefined && { offset: Number(values.offset) }),
          ...(values.limit !== undefined && { limit: Number(values.limit) }),
        });
        if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400, headers });
        return Response.json(await deps.molab.replay(parsed.data, request.signal), { headers });
      }
      if (url.searchParams.has("campaign")) {
        const docs = await deps.molab.listDocs(request.signal);
        return Response.json(await readCampaign(deps.molab, docs, request.signal), { headers });
      }
      const path = url.searchParams.get("document");
      if (path !== null) return Response.json(await deps.molab.readDoc(path, request.signal), { headers });
      const [scope, listed] = await Promise.all([deps.molab.scope(request.signal), deps.store.list(request.signal)]);
      return Response.json({ scope, ...listed, delegations: listed.delegations.map((item) => ({ ...item, gate: gateTrailer(item.path, item.record) ?? null })), caller: callerIdentity(), checkedAt: deps.now().toISOString() }, { headers });
    }
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers });
    const parsed = Action.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400, headers });
    const args = parsed.data;
    const exec = { signal: request.signal, caller: callerIdentity(), expectedDigest: args.digest, wakeSupervisor: true };
    const current = await deps.store.get(args.delegation, request.signal);
    if (current.digest !== args.digest) throw new MolabError(409, "This delegation changed. Refresh it and review the latest version before acting.", args.delegation);
    if (args.action === "pause" || args.action === "resume") {
      if (args.action === "pause" && !["open", "waiting"].includes(current.record.state)) {
        return Response.json({ error: "Only active or waiting delegations can be paused." }, { status: 409, headers });
      }
      if (args.action === "resume" && current.record.state !== "paused") {
        return Response.json({ error: "Only paused delegations can be continued." }, { status: 409, headers });
      }
      const result = await researchPause(deps).execute({ delegation: current.path, resume: args.action === "resume" }, exec);
      return Response.json(result, { headers });
    }
    if (current.record.state !== "blocked") return Response.json({ error: "This delegation is no longer waiting for an answer." }, { status: 409, headers });
    const gate = pendingGate(current.record);
    if (args.action === "approve" && (gate === undefined || args.gate?.gate !== gate.gate || args.gate.target !== gate.target)) {
      return Response.json({ error: "The approval target changed. Refresh and review the current request." }, { status: 409, headers });
    }
    if (args.action === "answer" && args.answers.trim() === "") {
      return Response.json({ error: "Write your answer before sending it." }, { status: 400, headers });
    }
    const result = await researchResume(deps).execute({
      delegation: current.path,
      answers: args.action === "approve" ? `approve ${gate!.target}${args.answers.trim() === "" ? "" : `\n${args.answers}`}` : args.answers,
      ...(args.action === "approve" && { approve: gate! }),
    }, exec);
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: error instanceof MolabError ? (error.status === 409 ? 409 : 502) : error instanceof SyntaxError ? 400 : 500, headers });
  }
}

export function mountResearchWeb(ctx: ResearchWebContext, deps: ResearchDeps): void {
  ctx.inject(["connection"], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: "/api/tack/research",
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request) => researchRequest(deps, request),
    }), "tack-research: browser API");
  });
}
