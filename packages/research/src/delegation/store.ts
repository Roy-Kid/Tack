/**
 * Delegations live in molab as `Delegation` knowledge documents. This is the
 * repository over molab's knowledge API: Tack keeps no authoritative copy.
 *
 * `update` is read → transform → replace-with-ifMatch; a concurrent writer
 * turns into a re-read and a second try, never a lost update.
 */
import { MolabError, type MolabClient } from "../molab/client.js";
import { sourceKindOf } from "../molab/refs.js";
import { type DelegationRecord, parseRecord, toWire } from "./model.js";
import { renderStatus, type StatusExtras } from "./status.js";

export const DELEGATION_CLASS = "Delegation";
const MAX_CONFLICT_RETRIES = 4;

export interface StoredDelegation {
  path: string;
  name: string;
  record: DelegationRecord;
  digest: string;
}

/** A document listed as a Delegation that Tack could not parse. */
export interface UnreadableDoc {
  path: string;
  error: string;
}

export interface OpenDelegation {
  name: string;
  /** Workspace-relative host directory (the bound node); "" for the served root. */
  hostPath: string;
  record: DelegationRecord;
  extras?: StatusExtras;
}

export class DelegationStore {
  constructor(
    private readonly molab: MolabClient,
    private readonly createdBy: string,
  ) {}

  async create(open: OpenDelegation): Promise<StoredDelegation> {
    const summary = await this.molab.createDoc({
      name: open.name,
      cls: DELEGATION_CLASS,
      hostPath: open.hostPath,
      body: renderStatus(open.name, open.record, open.extras),
      sources: [{ kind: sourceKindOf(open.record.scope), ref: open.record.scope }],
      record: toWire(open.record),
      createdBy: this.createdBy,
    });
    return this.get(summary.relPath);
  }

  async get(path: string, signal?: AbortSignal): Promise<StoredDelegation> {
    const doc = await this.molab.getRecord(path, signal);
    if (doc.cls !== DELEGATION_CLASS) throw new Error(`${path} is a ${doc.cls}, not a Delegation`);
    return { path: doc.relPath, name: nameOf(doc.relPath), record: parseRecord(doc.record), digest: doc.digest };
  }

  /**
   * Every Delegation document in the served scope. A document Tack cannot read
   * (written by hand, or by another tool) is reported, not fatal: one bad
   * file must not hide the others.
   */
  async list(signal?: AbortSignal): Promise<{ delegations: StoredDelegation[]; unreadable: UnreadableDoc[] }> {
    const docs = (await this.molab.listDocs(signal)).filter((doc) => doc.cls === DELEGATION_CLASS);
    const settled = await Promise.allSettled(docs.map((doc) => this.get(doc.relPath, signal)));
    const delegations: StoredDelegation[] = [];
    const unreadable: UnreadableDoc[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") delegations.push(result.value);
      else unreadable.push({ path: docs[index]!.relPath, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    });
    return { delegations, unreadable };
  }

  /**
   * Apply `change` to the stored record and write it back with the status
   * digest. Retries on a 409 by re-reading; `change` must be pure. A change
   * that leaves the record as it was (and no new status extras) is not
   * written: every Delegation write is a molab history entry.
   * With expectedDigest, a changed revision is rejected instead of retried:
   * a person's review does not automatically cover another revision.
   */
  async update(
    path: string,
    change: (record: DelegationRecord) => DelegationRecord,
    extras?: (record: DelegationRecord) => StatusExtras | undefined,
    expectedDigest?: string,
  ): Promise<StoredDelegation> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.get(path);
      // Human UI actions apply only to the revision the person reviewed.
      if (expectedDigest !== undefined && current.digest !== expectedDigest) {
        throw new MolabError(409, "This delegation changed. Refresh it and review the latest version before acting.", path);
      }
      const next = change(current.record);
      // A step that changes nothing writes nothing: no rewrite, no history entry.
      if (extras === undefined && JSON.stringify(toWire(next)) === JSON.stringify(toWire(current.record))) return current;
      try {
        const written = await this.molab.replaceRecord(path, {
          record: toWire(next),
          ifMatch: current.digest,
          body: renderStatus(current.name, next, extras?.(next)),
        });
        return { path, name: current.name, record: parseRecord(written.record), digest: written.digest };
      } catch (error) {
        if (error instanceof MolabError && error.status === 409 && attempt < MAX_CONFLICT_RETRIES) continue;
        throw error;
      }
    }
  }
}

function nameOf(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/, "") ?? path;
}
