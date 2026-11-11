/**
 * A typed client for the slice of `molab serve`'s HTTP API Tack uses.
 *
 * Scope is the server's job: `molab serve` opened at a project / experiment /
 * run exposes only that node and its descendants, so every call here is
 * already bounded by the bound scope. Responses are validated; a molab error
 * surfaces as {@link MolabError} with its status and detail.
 */
import { z } from "zod";
import {
  DocRecord,
  type DocSource,
  DryRun,
  Execution,
  Experiment,
  DocPage,
  KnowledgeGraph,
  KnowledgeList,
  LogChunk,
  NoteDetail,
  NoteSummary,
  Project,
  Run,
  ReplayPage,
  ReplayQuery,
  SearchHits,
  ServedValidation,
  ServeScope,
  WorkspaceInfo,
} from "./schemas.js";

export class MolabError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly endpoint: string,
  ) {
    super(`molab ${endpoint} answered ${status}: ${detail}`);
    this.name = "MolabError";
  }
}

export interface MolabClientOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
}

/** Where a run lives: molab routes address it by project, experiment and run id. */
export interface RunLocator {
  project: string;
  experiment: string;
  run: string;
}

export interface CreateExecution {
  mode?: "initial" | "rerun" | "resume" | "reproduce";
  basedOnExecutionId?: string;
  target?: string;
  requestKey: string;
  requestedBy: string;
}

export interface CreateDoc {
  name: string;
  cls: string;
  hostPath?: string;
  body: string;
  sources: DocSource[];
  record?: Record<string, unknown>;
  createdBy: string;
}

const seg = encodeURIComponent;
const anyJson = z.unknown();

function runPath(at: RunLocator): string {
  return `/api/projects/${seg(at.project)}/experiments/${seg(at.experiment)}/runs/${seg(at.run)}`;
}

export class MolabClient {
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: MolabClientOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async #call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    const endpoint = `${method} ${path.split("?")[0]}`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(signal !== undefined && { signal }),
      });
    } catch (error) {
      throw new MolabError(0, `cannot reach molab at ${this.#url} (${error instanceof Error ? error.message : String(error)})`, endpoint);
    }
    const text = await response.text();
    if (!response.ok) throw new MolabError(response.status, detailOf(text), endpoint);
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      throw new MolabError(response.status, "response is not JSON", endpoint);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new MolabError(response.status, `unexpected response shape: ${parsed.error.message}`, endpoint);
    return parsed.data;
  }

  // ── Scope and structure ────────────────────────────────────────────────────
  scope(signal?: AbortSignal): Promise<ServeScope> {
    return this.#call(ServeScope, "GET", "/api/workspace/scope", undefined, signal);
  }

  replay(options: Partial<ReplayQuery> = {}, signal?: AbortSignal): Promise<ReplayPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(ReplayQuery.parse(options))) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.#call(ReplayPage, "GET", `/api/history/replay?${query}`, undefined, signal);
  }

  replayDocument(commit: string, document: string, signal?: AbortSignal): Promise<z.infer<typeof NoteDetail>> {
    const query = new URLSearchParams({ commit, document });
    return this.#call(NoteDetail, "GET", `/api/history/replay/document?${query}`, undefined, signal);
  }

  /** The served directory on disk (where workers run). */
  async root(signal?: AbortSignal): Promise<string> {
    return (await this.#call(WorkspaceInfo, "GET", "/api/workspace/info", undefined, signal)).root;
  }

  /** The structural snapshot molab builds for agents (projects, experiments, recent and failed runs, knowledge). */
  context(query: { projectId?: string; experimentId?: string; runId?: string } = {}, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.#call(anyJson, "GET", `/api/workspace/context${suffix}`, undefined, signal);
  }

  /** molab's layout and knowledge rules over the served scope (`molab validate`, bounded). Writes nothing. */
  validate(errorsOnly = false, signal?: AbortSignal): Promise<ServedValidation> {
    return this.#call(ServedValidation, "GET", `/api/workspace/validate${errorsOnly ? "?errorsOnly=true" : ""}`, undefined, signal);
  }

  listProjects(signal?: AbortSignal): Promise<Project[]> {
    return this.#call(Project.array(), "GET", "/api/projects", undefined, signal);
  }

  listExperiments(project: string, signal?: AbortSignal): Promise<Experiment[]> {
    return this.#call(Experiment.array(), "GET", `/api/projects/${seg(project)}/experiments`, undefined, signal);
  }

  createExperiment(
    project: string,
    body: { name: string; description?: string; parameterSpace?: Record<string, unknown>; workflowSource?: Record<string, unknown>; defaultTarget?: string },
  ): Promise<Experiment> {
    return this.#call(Experiment, "POST", `/api/projects/${seg(project)}/experiments`, body);
  }

  listRuns(project: string, experiment: string, signal?: AbortSignal): Promise<Run[]> {
    return this.#call(Run.array(), "GET", `/api/projects/${seg(project)}/experiments/${seg(experiment)}/runs`, undefined, signal);
  }

  createRun(project: string, experiment: string, body: { params: Record<string, unknown>; target?: string }): Promise<Run> {
    return this.#call(Run, "POST", `/api/projects/${seg(project)}/experiments/${seg(experiment)}/runs`, body);
  }

  getRun(at: RunLocator, signal?: AbortSignal): Promise<Run> {
    return this.#call(Run, "GET", runPath(at), undefined, signal);
  }

  /** Preview current code in isolation, or explicitly inspect saved IR/inventory. */
  dryRun(project: string, experiment: string, signal?: AbortSignal, source: "code" | "stored" = "code"): Promise<DryRun> {
    return this.#call(DryRun, "GET", `/api/projects/${seg(project)}/experiments/${seg(experiment)}/workflow/dry-run?source=${source}`, undefined, signal);
  }

  // ── Attempts ───────────────────────────────────────────────────────────────
  listExecutions(at: RunLocator, signal?: AbortSignal): Promise<Execution[]> {
    return this.#call(Execution.array(), "GET", `${runPath(at)}/executions`, undefined, signal);
  }

  getExecution(at: RunLocator, execution: string, signal?: AbortSignal): Promise<Execution> {
    return this.#call(Execution, "GET", `${runPath(at)}/executions/${seg(execution)}`, undefined, signal);
  }

  /** Create one attempt; molab submits it. Idempotent per `requestKey`. */
  createExecution(at: RunLocator, body: CreateExecution): Promise<Execution> {
    return this.#call(Execution, "POST", `${runPath(at)}/executions`, body);
  }

  cancelExecution(at: RunLocator, execution: string): Promise<unknown> {
    return this.#call(anyJson, "POST", `${runPath(at)}/executions/${seg(execution)}/cancel`);
  }

  async outputs(at: RunLocator, execution: string, signal?: AbortSignal): Promise<unknown> {
    const endpoint = `${runPath(at)}/executions/${seg(execution)}/outputs`;
    const value = await this.#call(anyJson, "GET", endpoint, undefined, signal);
    if (typeof value === "object" && value !== null && "assets" in value && Array.isArray(value.assets)) {
      const run = await this.getRun(at, signal);
      for (const asset of value.assets) {
        if (asset?.runId !== run.id || asset?.executionId !== execution ||
            asset?.projectId !== run.projectId) {
          throw new MolabError(200, "outputs contain an asset from another run, project or execution; refusing mixed evidence", `GET ${endpoint}`);
        }
      }
    }
    return value;
  }

  log(at: RunLocator, execution: string, stream: "stdout" | "stderr" | "run", offset: number, signal?: AbortSignal): Promise<LogChunk> {
    return this.#call(LogChunk, "GET", `${runPath(at)}/executions/${seg(execution)}/logs/${stream}?offset=${offset}`, undefined, signal);
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  async listDocs(signal?: AbortSignal): Promise<NoteSummary[]> {
    return (await this.#call(KnowledgeList, "GET", "/api/knowledge", undefined, signal)).notes;
  }

  /** The whole knowledge graph in one read: documents and the typed links between them. */
  knowledgeGraph(signal?: AbortSignal): Promise<KnowledgeGraph> {
    return this.#call(KnowledgeGraph, "GET", "/api/knowledge/graph", undefined, signal);
  }

  search(q: string, cls?: string, signal?: AbortSignal): Promise<z.infer<typeof SearchHits>> {
    const params = new URLSearchParams({ q, ...(cls !== undefined && { type: cls }) });
    return this.#call(SearchHits, "GET", `/api/knowledge/search?${params}`, undefined, signal);
  }

  readDoc(path: string, signal?: AbortSignal): Promise<z.infer<typeof NoteDetail>> {
    return this.#call(NoteDetail, "GET", `/api/knowledge/note?${new URLSearchParams({ path })}`, undefined, signal);
  }

  /** A document rendered the way a reader sees it: one self-contained HTML page. */
  docPage(path: string, signal?: AbortSignal): Promise<z.infer<typeof DocPage>> {
    return this.#call(DocPage, "GET", `/api/knowledge/doc/page?${new URLSearchParams({ path })}`, undefined, signal);
  }

  createDoc(body: CreateDoc): Promise<NoteSummary> {
    return this.#call(NoteSummary, "POST", "/api/knowledge/doc", body);
  }

  /** Add one typed provenance edge from document `path` to `target` (e.g. role `supersedes` to an older plan). */
  embed(path: string, body: { target_kind: "run" | "experiment" | "asset" | "reference"; target: string; role: "derived_from" | "cites" | "supersedes" | "supports" | "contradicts" | "records" | "references" }): Promise<unknown> {
    return this.#call(anyJson, "POST", `/api/knowledge/doc/embed?${new URLSearchParams({ path })}`, body);
  }

  /** Rewrite a document's narrative (its frontmatter and edges' history stay). */
  writeBody(path: string, body: string): Promise<unknown> {
    return this.#call(anyJson, "PUT", `/api/knowledge/doc?${new URLSearchParams({ path })}`, { body });
  }

  /** Set a document's lifecycle status and/or tags (e.g. status "retracted"). */
  setMeta(path: string, body: { status?: string; tags?: string[] }): Promise<NoteSummary> {
    return this.#call(NoteSummary, "PATCH", `/api/knowledge/doc/meta?${new URLSearchParams({ path })}`, body);
  }

  /** Delete a document; molab's history keeps what it said. */
  deleteDoc(path: string): Promise<unknown> {
    return this.#call(anyJson, "DELETE", `/api/knowledge/doc?${new URLSearchParams({ path })}`);
  }

  getRecord(path: string, signal?: AbortSignal): Promise<DocRecord> {
    return this.#call(DocRecord, "GET", `/api/knowledge/doc/record?${new URLSearchParams({ path })}`, undefined, signal);
  }

  /** Replace a document's record whole; a stale `ifMatch` is a 409 {@link MolabError}. */
  replaceRecord(path: string, body: { record: Record<string, unknown>; ifMatch: string; body?: string }): Promise<DocRecord> {
    return this.#call(DocRecord, "PATCH", `/api/knowledge/doc/record?${new URLSearchParams({ path })}`, body);
  }
}


function detailOf(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const detail = body.detail ?? body.message;
    if (typeof detail === "string") return detail;
    if (detail !== undefined) return JSON.stringify(detail);
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, 500) || "(empty body)";
}
