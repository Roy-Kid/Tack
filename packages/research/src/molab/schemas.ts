/**
 * The parts of molab's HTTP responses Tack reads. Unknown fields pass through:
 * molab owns these shapes, Tack only relies on the fields named here.
 */
import { z } from "zod";

export const ServeScope = z.looseObject({ kind: z.string(), id: z.string(), name: z.string() });
export type ServeScope = z.infer<typeof ServeScope>;

export const WorkspaceInfo = z.looseObject({ root: z.string() });

export const Project = z.looseObject({ id: z.string(), name: z.string(), path: z.string(), ref: z.string() });
export type Project = z.infer<typeof Project>;

export const Experiment = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  ref: z.string(),
});
export type Experiment = z.infer<typeof Experiment>;

export const Run = z.looseObject({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  projectId: z.string(),
  experimentId: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type Run = z.infer<typeof Run>;

/** Terminal attempt statuses; anything else is still moving. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export const Execution = z.looseObject({
  id: z.string(),
  runId: z.string(),
  mode: z.string(),
  status: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullish(),
  executor: z.record(z.string(), z.unknown()).default({}),
  error: z.record(z.string(), z.unknown()).nullish(),
});
export type Execution = z.infer<typeof Execution>;

export const LogChunk = z.looseObject({ text: z.string(), nextOffset: z.number(), eof: z.boolean() });
export type LogChunk = z.infer<typeof LogChunk>;

export const NoteSummary = z.looseObject({
  name: z.string(),
  /** Display title: the frontmatter title, else the first heading, else the name. Older molab omits it. */
  title: z.string().default(""),
  relPath: z.string(),
  hostPath: z.string().default(""),
  excerpt: z.string().default(""),
  cls: z.string().default("Note"),
});
export type NoteSummary = z.infer<typeof NoteSummary>;

export const KnowledgeList = z.looseObject({ notes: z.array(NoteSummary) });

/**
 * `GET /api/knowledge/graph`: every document and every link one document makes.
 * A `document` edge's target is the other document's `relPath`; a `ref` edge's
 * is a `molab:` reference, an `external` edge's a URL, a `missing` edge's a
 * path no document has.
 */
export const KnowledgeGraph = z.looseObject({
  nodes: z.array(NoteSummary),
  edges: z.array(z.looseObject({ source: z.string(), target: z.string(), role: z.string(), kind: z.string() })),
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;

export const SearchHits = z.looseObject({ hits: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() });

export const NoteDetail = z.looseObject({ name: z.string(), relPath: z.string(), body: z.string() });

/** `GET /api/knowledge/doc/page`: one document as a self-contained HTML page, assets inlined. */
export const DocPage = z.looseObject({ title: z.string(), html: z.string() });

export const DocRecord = z.looseObject({
  relPath: z.string(),
  cls: z.string(),
  record: z.record(z.string(), z.unknown()),
  digest: z.string(),
});
export type DocRecord = z.infer<typeof DocRecord>;

export const ValidationRow = z.looseObject({
  path: z.string(),
  rule: z.string(),
  detail: z.string(),
  severity: z.string(),
  hint: z.string().default(""),
});
export type ValidationRow = z.infer<typeof ValidationRow>;

export const ServedValidation = z.looseObject({
  root: z.string(),
  ok: z.boolean(),
  errorCount: z.number(),
  warningCount: z.number(),
  violations: z.array(ValidationRow),
});
export type ServedValidation = z.infer<typeof ServedValidation>;

/**
 * What `GET /api/projects/{project}/experiments/{experiment}/workflow/dry-run`
 * compiles: the waves, branches and runs a stored workflow would produce,
 * without creating anything. `experiment.path` is the workspace-relative
 * experiment path a dry_run approval names.
 */
export const DryRun = z.looseObject({
  experiment: z.looseObject({ id: z.string(), name: z.string(), path: z.string() }),
  workflow: z.looseObject({ name: z.string() }),
  waves: z.array(z.array(z.string())).default([]),
  branches: z.array(z.looseObject({ source: z.string(), label: z.string().default(""), target: z.string() })).default([]),
  runs: z.array(z.looseObject({ params: z.record(z.string(), z.unknown()).default({}) })).default([]),
  tasks: z.array(z.looseObject({ name: z.string(), dependsOn: z.array(z.string()).default([]) })).default([]),
  source: z.enum(["code", "stored"]).default("stored"),
  workflowHash: z.string().nullish(),
  definitionHash: z.string().nullish(),
  entrypoint: z.string().nullish(),
  registeredRuns: z.array(z.looseObject({ params: z.record(z.string(), z.unknown()) })).default([]),
});
export type DryRun = z.infer<typeof DryRun>;

/** Research playback is a read-model over Molab's existing history/attempts. */
export const ReplayQuery = z.object({
  projectId: z.string().optional(), experimentId: z.string().optional(), runId: z.string().optional(),
  kind: z.enum(["experiment", "run", "execution", "knowledge", "asset", "history"]).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50),
  asOf: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type ReplayQuery = z.infer<typeof ReplayQuery>;

export const ReplayPage = z.object({
  events: z.array(z.object({
    id: z.string(), at: z.string(), kind: z.string(), action: z.string(), title: z.string(),
    ref: z.string().nullable(), actor: z.object({ id: z.string(), type: z.string(), name: z.string().nullish() }).nullable(),
    commit: z.string().nullable(), document: z.string().nullable(), details: z.record(z.string(), z.unknown()),
  })),
  total: z.number(), offset: z.number(), nextOffset: z.number().nullable(), asOf: z.string(),
  historyAvailable: z.boolean(), warnings: z.array(z.string()),
});
export type ReplayPage = z.infer<typeof ReplayPage>;

/** A source a sourced knowledge document derives from. */
export interface DocSource {
  kind: "run" | "experiment" | "asset" | "project" | "reference" | "file";
  ref: string;
}
