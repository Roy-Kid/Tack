/**
 * The background half of waiting: check every waiting delegation against
 * molab, write what settled, and wake the supervising session with a brief.
 *
 * Durable by construction. The "a wake is owed" fact is written to the
 * delegation (`supervisor.wake = "pending"`) in the same write that settles
 * the wait, and cleared only after the wake was delivered. A crash between the
 * two re-delivers on the next tick or after a restart; it never loses a wake.
 */
import { pendingWaits } from "./delegation/model.js";
import type { DelegationStore, StoredDelegation } from "./delegation/store.js";
import type { MolabClient } from "./molab/client.js";
import { foldSettled, reconcile, resumeBrief } from "./reconcile.js";

/** Delivers a brief about `delegation` to a supervising session; returns the session that received it. */
export interface Waker {
  wake(sessionId: string | undefined, text: string, summary: string, delegation: string): Promise<string>;
}

export interface WatcherLogger {
  info(message: string): void;
  warn(message: string): void;
}

const WAKE_PENDING = "pending";

export class Watcher {
  #running: Promise<void> | undefined;
  #listFailure: string | undefined;
  readonly #unreadable = new Set<string>();

  constructor(
    private readonly molab: MolabClient,
    private readonly store: DelegationStore,
    private readonly waker: Waker,
    private readonly logger: WatcherLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One pass; overlapping calls share the pass in flight. */
  tick(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    let delegations: StoredDelegation[];
    try {
      const listed = await this.store.list();
      delegations = listed.delegations;
      for (const doc of listed.unreadable) {
        if (this.#unreadable.has(doc.path)) continue;
        this.#unreadable.add(doc.path);
        this.logger.warn(`tack-research: skipping ${doc.path}, which Tack cannot read: ${doc.error}`);
      }
    } catch (error) {
      // Say it once per distinct failure, not on every tick of an outage.
      const reason = message(error);
      if (reason !== this.#listFailure) this.logger.warn(`tack-research: cannot list delegations: ${reason}`);
      this.#listFailure = reason;
      return;
    }
    if (this.#listFailure !== undefined) this.logger.info("tack-research: molab is reachable again");
    this.#listFailure = undefined;
    for (const delegation of delegations) {
      try {
        await this.#check(delegation);
      } catch (error) {
        this.logger.warn(`tack-research: ${delegation.path}: ${message(error)}`);
      }
    }
  }

  async #check(delegation: StoredDelegation): Promise<void> {
    const { record } = delegation;
    if (record.state === "paused" || record.state === "done" || record.state === "stopped") return;
    let current = delegation;
    if (pendingWaits(record).length > 0) {
      const reconciled = await reconcile(this.molab, record, this.now());
      const settled = reconciled.observations.some((observation) => observation.kind === "terminal" || observation.kind === "expired");
      if (reconciled.changed) {
        current = await this.store.update(delegation.path, (latest) => {
          const folded = foldSettled(latest, reconciled.record);
          return settled ? { ...folded, supervisor: { ...folded.supervisor, wake: WAKE_PENDING } } : folded;
        });
      }
    }
    if (current.record.supervisor.wake !== WAKE_PENDING) return;
    const brief = resumeBrief(current.path, { record: current.record, observations: [], changed: false });
    const sessionId = await this.waker.wake(current.record.supervisor.session_id, brief, `research: ${current.name} needs a decision`, current.path);
    await this.store.update(current.path, (latest) => {
      const { wake: _wake, ...supervisor } = latest.supervisor;
      return { ...latest, supervisor: { ...supervisor, session_id: sessionId } };
    });
    this.logger.info(`tack-research: woke session ${sessionId} for ${current.path}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
