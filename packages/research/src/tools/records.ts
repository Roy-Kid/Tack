/**
 * How research records are written into molab: what a citation becomes, what
 * a document is called, and how a retried write is kept from doubling.
 */
import { createHash } from "node:crypto";
import { type DelegationRecord, priorWrite, recordWrite } from "../delegation/model.js";
import { type CreateDoc, MolabError } from "../molab/client.js";
import { isAssetRef, parseRef, runRef } from "../molab/refs.js";
import type { DocSource } from "../molab/schemas.js";
import type { ResearchDeps } from "./types.js";

/** A molab ref as the source kind molab's create route takes. */
export function sourceOf(ref: string): DocSource {
  if (isAssetRef(ref)) return { kind: "asset", ref };
  const parsed = parseRef(ref);
  if (parsed.execution !== undefined) return { kind: "run", ref: runRef(parsed.experiment!, parsed.run!) };
  if (parsed.run !== undefined) return { kind: "run", ref };
  if (parsed.experiment !== undefined) return { kind: "experiment", ref };
  return { kind: "project", ref };
}

/** A knowledge document path (`<host>/knowledges/<slug>.md`), as opposed to any other workspace file. */
export function isKnowledgePath(item: string): boolean {
  return /(^|\/)knowledges\/[^/]+\.md$/.test(item);
}

/**
 * Sort citations by what molab makes of them: molab refs and workspace files
 * are create-time sources; knowledge documents are typed edges added after
 * the document exists. A worker's product under scratch/ is a file source.
 */
export function citations(items: readonly string[]): { sources: DocSource[]; documents: string[] } {
  const sources = new Map<string, DocSource>();
  const documents = new Set<string>();
  for (const item of items) {
    const source: DocSource | undefined = item.startsWith("molab:") ? sourceOf(item) : isKnowledgePath(item) ? undefined : { kind: "file", ref: item };
    if (source === undefined) documents.add(item);
    else sources.set(`${source.kind}:${source.ref}`, source);
  }
  return { sources: [...sources.values()], documents: [...documents] };
}

/**
 * The Plan a delegation is working to, as a citation. A report, an assessment
 * and a finding each refer to the plan they answer, so the knowledge graph
 * links a conclusion back to its question without anyone remembering to.
 */
export function planCitation(record: { current_plan?: string | null | undefined }): string[] {
  return record.current_plan ? [record.current_plan] : [];
}

/** The host directory of a knowledge document path. */
export function hostOf(path: string): string {
  const index = path.lastIndexOf("knowledges/");
  return index <= 0 ? "" : path.slice(0, index - 1);
}

/**
 * A name for a document that records one event (a brief, a worker report, an
 * assessment): `<kind> <date> <title>`. A document revised in place (a plan,
 * a report) keeps a stable name instead.
 */
export function docName(kind: string, title: string, now: Date): string {
  return `${kind} ${now.toISOString().slice(0, 10)} ${title}`.trim();
}

/** A stable key for a write's content: the same call yields the same key. */
export function contentKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** Create a document, then link the knowledge documents it cites. The author is Tack unless the document names one (a worker's report). */
export async function writeCited(
  deps: ResearchDeps,
  doc: Omit<CreateDoc, "sources" | "createdBy"> & { createdBy?: string },
  cited: readonly string[],
  fallback: string,
  role: "cites" | "derived_from",
): Promise<{ relPath: string }> {
  const { sources, documents } = citations(cited);
  const created = await deps.molab.createDoc({ ...doc, sources: sources.length > 0 ? sources : [sourceOf(fallback)], createdBy: doc.createdBy ?? deps.config.createdBy });
  for (const target of documents) await deps.molab.embed(created.relPath, { target_kind: "reference", target, role });
  return created;
}

/**
 * Write once per content key within a delegation. A retry of the same write
 * (a lost response, a model repeating itself) returns the document the first
 * write produced instead of writing a second one.
 *
 * It does not touch the Delegation: the caller folds `remember` into the one
 * record update its step makes, so a step is one Delegation write, not two.
 */
export async function writeOnce(
  deps: ResearchDeps,
  delegationPath: string,
  key: string,
  write: () => Promise<{ relPath: string }>,
): Promise<{ relPath: string; reused: boolean; remember: (record: DelegationRecord) => DelegationRecord }> {
  const current = await deps.store.get(delegationPath);
  const prior = priorWrite(current.record, key);
  if (prior !== undefined) return { relPath: prior, reused: true, remember: (record) => record };
  const created = await write();
  return { relPath: created.relPath, reused: false, remember: (record) => recordWrite(record, key, created.relPath) };
}

/** Delete a document this delegation replaced; one already gone is not an error. */
export async function deleteDoc(deps: ResearchDeps, path: string): Promise<void> {
  try {
    await deps.molab.deleteDoc(path);
  } catch (error) {
    if (!(error instanceof MolabError && error.status === 404)) throw error;
  }
}
