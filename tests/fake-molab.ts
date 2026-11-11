/**
 * An in-memory stand-in for `molab serve`, covering the endpoints the research
 * plugin calls, with the same wire shapes (camelCase JSON, workspace-relative
 * paths, `molab:` refs, digest-checked record replacement, request-key
 * idempotent attempts). Tests steer it: settle an attempt, lose the next
 * response, or force one record conflict.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeExecution {
  id: string;
  runId: string;
  mode: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
  executor: Record<string, unknown>;
  environment: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

export interface FakeDoc {
  cls: string;
  name: string;
  hostPath: string;
  createdBy: string;
  record: Record<string, unknown>;
  body: string;
  status?: string;
  sources: { kind: string; ref: string }[];
  edges: { target: string; role: string }[];
}

export interface FakeMolab {
  url: string;
  readonly docs: Map<string, FakeDoc>;
  readonly executions: Map<string, FakeExecution[]>;
  readonly requests: string[];
  /** Documents a create rewrote in place (the same name again), in order. */
  readonly rewrites: string[];
  /** Documents deleted, in order. */
  readonly deleted: string[];
  /** Create an experiment and a run under the served project; returns their ids. */
  seedRun(params?: Record<string, unknown>): { experiment: string; run: string };
  settle(run: string, execution: string, status: string): void;
  /** Process the next request matching `pattern`, then drop the connection instead of answering. */
  loseNextResponse(pattern: RegExp): void;
  /** Answer the next record replacement with a 409, without writing. */
  conflictNext(): void;
  /** Put a document on disk as another author would, bypassing every create check. */
  plantDoc(relPath: string, doc: Partial<FakeDoc> & { cls: string }): void;
  /** Put an ordinary workspace file in place (a worker's product). */
  plantFile(relPath: string): void;
  /** What `GET /api/projects/{p}/experiments/{id}/workflow/dry-run` answers for an experiment (until set: 404, no workflow stored). */
  dryRun(experiment: string, answer: { status?: number; body: unknown }): void;
  /** What `GET /api/workspace/validate` reports. */
  violations: { path: string; rule: string; detail: string; severity: string; hint: string }[];
  close(): Promise<void>;
}

const PROJECT = "P1";
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function digestOf(doc: FakeDoc): string {
  return createHash("sha256").update(JSON.stringify([doc.record, doc.body])).digest("hex");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

export async function startFakeMolab(root = "/tmp/fake-ws/projects/polymer"): Promise<FakeMolab> {
  const experiments = new Map<string, { id: string; projectId: string; name: string; path: string; ref: string }>();
  const runs = new Map<string, { id: string; name: string; path: string; projectId: string; experimentId: string; parameters: Record<string, unknown> }>();
  const executions = new Map<string, FakeExecution[]>();
  const docs = new Map<string, FakeDoc>();
  const requests: string[] = [];
  const rewrites: string[] = [];
  const deleted: string[] = [];
  const state = { violations: [] as FakeMolab["violations"] };
  const files = new Set<string>();
  const dryRuns = new Map<string, { status?: number; body: unknown }>();
  let lose: RegExp | undefined;
  let conflict = false;
  let counter = 0;

  const addExperiment = (name: string) => {
    const id = `E${++counter}`;
    const experiment = { id, projectId: PROJECT, name, path: `experiments/${slug(name)}`, ref: `molab:experiment/${id}` };
    experiments.set(id, experiment);
    return experiment;
  };
  const addRun = (experimentId: string, parameters: Record<string, unknown>) => {
    const experiment = experiments.get(experimentId)!;
    const id = `R${++counter}`;
    const name = Object.entries(parameters).map(([k, v]) => `${k}=${String(v)}`).join("_") || id;
    const run = { id, name, path: `${experiment.path}/runs/${name}`, projectId: PROJECT, experimentId, parameters };
    runs.set(id, run);
    executions.set(id, []);
    return run;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    requests.push(`${method} ${url.pathname}`);
    const send = (status: number, value: unknown) => {
      if (lose?.test(`${method} ${url.pathname}`)) {
        lose = undefined;
        res.destroy();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const fail = (status: number, detail: string) => send(status, { detail });
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/api/workspace/scope") return send(200, { kind: "workspace.project", id: PROJECT, name: "Polymer" });
    if (method === "GET" && path === "/api/workspace/info") return send(200, { root, projectCount: 1, assetCount: 0 });
    if (method === "GET" && path === "/api/workspace/validate") {
      const rows = url.searchParams.get("errorsOnly") === "true" ? state.violations.filter((row) => row.severity === "error") : state.violations;
      const errors = rows.filter((row) => row.severity === "error").length;
      return send(200, { root, ok: errors === 0, errorCount: errors, warningCount: rows.length - errors, violations: rows });
    }
    if (method === "GET" && path === "/api/workspace/context") return send(200, { experiments: [...experiments.values()], runs: [...runs.values()] });
    if (method === "GET" && path === "/api/projects") return send(200, [{ id: PROJECT, name: "Polymer", path: "", ref: `molab:project/${PROJECT}`, created: "" }]);

    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/workflow\/dry-run$/)) && method === "GET") {
      if (!experiments.has(m[2]!)) return fail(404, "experiment not found");
      const answer = dryRuns.get(m[2]!);
      if (answer === undefined) return fail(404, "no workflow.ir.json is stored for this experiment");
      return send(answer.status ?? 200, answer.body);
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments$/))) {
      if (method === "GET") return send(200, [...experiments.values()]);
      return send(201, addExperiment(String(body?.name)));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/runs$/))) {
      if (!experiments.has(m[2]!)) return fail(404, "experiment not found");
      if (method === "GET") return send(200, [...runs.values()].filter((run) => run.experimentId === m![2]));
      return send(201, addRun(m[2]!, (body?.params as Record<string, unknown>) ?? {}));
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/experiments\/([^/]+)\/runs\/([^/]+)(\/.*)?$/))) {
      const run = runs.get(m[3]!);
      if (run === undefined) return fail(404, "run not found");
      const rest = m[4] ?? "";
      const attempts = executions.get(run.id)!;
      if (rest === "" && method === "GET") return send(200, run);
      if (rest === "/executions" && method === "GET") return send(200, attempts);
      if (rest === "/executions" && method === "POST") {
        const key = body?.requestKey as string | undefined;
        const existing = key === undefined ? undefined : attempts.find((attempt) => attempt.executor.request_key === key);
        if (existing !== undefined) return send(201, existing);
        const attempt: FakeExecution = {
          id: `e${String(attempts.length + 1).padStart(2, "0")}`,
          runId: run.id,
          mode: String(body?.mode ?? "initial"),
          status: "queued",
          createdAt: new Date().toISOString(),
          executor: { backend: "molq", target: body?.target ?? null, ...(key !== undefined && { request_key: key }) },
          environment: {},
        };
        attempts.push(attempt);
        return send(201, attempt);
      }
      if ((m = rest.match(/^\/executions\/([^/]+)(\/.*)?$/))) {
        const attempt = attempts.find((item) => item.id === m![1]);
        if (attempt === undefined) return fail(404, "execution not found");
        const tail = m[2] ?? "";
        if (tail === "" && method === "GET") return send(200, attempt);
        if (tail === "/cancel" && method === "POST") {
          attempt.status = "cancelled";
          return send(200, attempt);
        }
        if (tail === "/outputs") return send(200, { status: attempt.status, results: { conductivity: 1.25 } });
        if (tail.startsWith("/logs/")) return send(200, { text: "step 100 ok\n", nextOffset: 12, eof: true, size: 12 });
      }
      return fail(404, `no route ${method} ${path}`);
    }

    if (method === "GET" && path === "/api/knowledge") {
      return send(200, {
        notes: [...docs.entries()].map(([relPath, doc]) => ({ name: doc.name, relPath, hostPath: doc.hostPath, excerpt: doc.body.slice(0, 80), cls: doc.cls })),
        references: [],
        total: docs.size,
      });
    }
    if (method === "GET" && path === "/api/knowledge/doc/page") {
      const doc = docs.get(url.searchParams.get("path") ?? "");
      if (doc === undefined) return fail(404, "note not found");
      // Stands in for molab's renderer: a page that carries the title and the narrative, never raw markup from it.
      const escape = (text: string) => text.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
      return send(200, { title: doc.name, html: `<!doctype html><html><body><h1>${escape(doc.name)}</h1><main>${escape(doc.body)}</main></body></html>` });
    }
    if (method === "GET" && path === "/api/knowledge/graph") {
      const kindOf = (target: string) => (docs.has(target) ? "document" : target.startsWith("molab:") ? "ref" : /^https?:/.test(target) ? "external" : "missing");
      return send(200, {
        nodes: [...docs.entries()].map(([relPath, doc]) => ({ name: doc.name, relPath, hostPath: doc.hostPath, excerpt: doc.body.slice(0, 80), cls: doc.cls })),
        edges: [...docs.entries()].flatMap(([source, doc]) => doc.edges.map((edge) => ({ source, target: edge.target, role: edge.role, kind: kindOf(edge.target) }))),
      });
    }
    if (method === "GET" && path === "/api/knowledge/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return send(200, { hits: [...docs.entries()].filter(([, doc]) => doc.body.toLowerCase().includes(q)).map(([relPath]) => ({ relPath })), truncated: false });
    }
    if (method === "GET" && path === "/api/knowledge/note") {
      const doc = docs.get(url.searchParams.get("path") ?? "");
      return doc === undefined ? fail(404, "note not found") : send(200, { name: doc.name, relPath: url.searchParams.get("path"), body: doc.body, links: [] });
    }
    if (method === "POST" && path === "/api/knowledge/doc") {
      const name = String(body?.name);
      const hostPath = String(body?.hostPath ?? "");
      const relPath = `${hostPath === "" ? "" : `${hostPath}/`}knowledges/${slug(name)}.md`;
      const cls = String(body?.cls ?? "Note");
      const sources = (body?.sources as FakeDoc["sources"]) ?? [];
      const record = (body?.record as Record<string, unknown>) ?? {};
      if (["Report", "Finding", "Plan", "Observation", "Delegation"].includes(cls) && sources.length === 0) return fail(422, `${cls} requires at least one SourceRef`);
      if (sources.some((source) => source.kind === "reference" && !/^https?:\/\//.test(source.ref))) return fail(422, "reference is not an http(s) URL or a DOI");
      if (sources.some((source) => source.kind === "file" && !files.has(source.ref))) return fail(422, "file source is not a file in this workspace");
      if (cls === "Delegation" && (record.goal === undefined || record.scope === undefined)) return fail(422, "a Delegation stores its goal and its scope");
      const prior = docs.get(relPath);
      if (prior !== undefined) {
        // As molab's write_knowledge: the same name rewrites the document in place (frontmatter merged, a non-empty body replaced).
        if (prior.cls !== cls) return fail(422, `${relPath} is a ${prior.cls}, not a ${cls}`);
        rewrites.push(relPath);
        const text = String(body?.body ?? "");
        docs.set(relPath, { ...prior, record: { ...prior.record, ...record }, body: text === "" ? prior.body : text, sources: sources.length > 0 ? sources : prior.sources });
        return send(201, { name, relPath, hostPath, excerpt: "", cls });
      }
      docs.set(relPath, { cls, name, hostPath, createdBy: String(body?.createdBy ?? "ui"), record, body: String(body?.body ?? ""), sources, edges: [] });
      return send(201, { name, relPath, hostPath, excerpt: "", cls });
    }
    if (method === "POST" && path === "/api/knowledge/doc/embed") {
      const doc = docs.get(url.searchParams.get("path") ?? "");
      if (doc === undefined) return fail(404, "note not found");
      if (body?.target_kind === "reference" && !docs.has(String(body.target))) return fail(404, "reference not found");
      doc.edges.push({ target: String(body?.target), role: String(body?.role ?? "references") });
      return send(200, { srcPath: url.searchParams.get("path"), target: body?.target, role: body?.role });
    }
    if (method === "PATCH" && path === "/api/knowledge/doc/meta") {
      const relPath = url.searchParams.get("path") ?? "";
      const doc = docs.get(relPath);
      if (doc === undefined) return fail(404, "note not found");
      if (typeof body?.status === "string") doc.status = body.status;
      return send(200, { name: doc.name, relPath, hostPath: doc.hostPath, excerpt: "", cls: doc.cls, status: doc.status });
    }
    if (method === "DELETE" && path === "/api/knowledge/doc") {
      const relPath = url.searchParams.get("path") ?? "";
      if (!docs.delete(relPath)) return fail(404, "note not found");
      deleted.push(relPath);
      return send(200, { message: `note '${relPath}' deleted` });
    }
    if (method === "PUT" && path === "/api/knowledge/doc") {
      const relPath = url.searchParams.get("path") ?? "";
      const doc = docs.get(relPath);
      if (doc === undefined) return fail(404, "note not found");
      doc.body = String(body?.body ?? "");
      return send(200, { name: doc.name, relPath, body: doc.body, links: [] });
    }
    if (path === "/api/knowledge/doc/record") {
      const relPath = url.searchParams.get("path") ?? "";
      const doc = docs.get(relPath);
      if (doc === undefined) return fail(404, "note not found");
      if (method === "GET") return send(200, { relPath, cls: doc.cls, record: doc.record, digest: digestOf(doc) });
      if (method === "PATCH") {
        if (conflict) {
          conflict = false;
          return fail(409, "changed since it was read");
        }
        if (body?.ifMatch !== undefined && body.ifMatch !== digestOf(doc)) return fail(409, "changed since it was read");
        const record = body?.record as Record<string, unknown>;
        if (doc.cls === "Delegation" && (record.goal === undefined || record.scope === undefined)) return fail(422, "invalid Delegation record");
        doc.record = record;
        if (typeof body?.body === "string") doc.body = body.body;
        return send(200, { relPath, cls: doc.cls, record: doc.record, digest: digestOf(doc) });
      }
    }
    return fail(404, `no route ${method} ${path}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: String(error) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    docs,
    executions,
    requests,
    rewrites,
    deleted,
    seedRun(params = { seq: "ABAB", seed: 1 }) {
      const experiment = addExperiment(`Screen ${counter + 1}`);
      const run = addRun(experiment.id, params);
      return { experiment: experiment.id, run: run.id };
    },
    settle(run, execution, status) {
      const attempt = executions.get(run)?.find((item) => item.id === execution);
      if (attempt === undefined) throw new Error(`no attempt ${execution} on ${run}`);
      attempt.status = status;
      attempt.finishedAt = new Date().toISOString();
    },
    loseNextResponse(pattern) {
      lose = pattern;
    },
    conflictNext() {
      conflict = true;
    },
    plantFile(relPath) {
      files.add(relPath);
    },
    dryRun(experiment, answer) {
      dryRuns.set(experiment, answer);
    },
    plantDoc(relPath, doc) {
      docs.set(relPath, { name: relPath.split("/").at(-1)!.replace(/\.md$/, ""), hostPath: "", createdBy: "roykid", record: {}, body: "", sources: [], edges: [], ...doc });
    },
    get violations() {
      return state.violations;
    },
    set violations(rows) {
      state.violations = rows;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
