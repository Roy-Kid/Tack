/**
 * A stand-in for the research plugin's workers port (DSH's subagent service
 * behind `research_dispatch`): records every start, lets a test settle a
 * worker with a structured value or final text, and records continuations.
 */
import type { WorkerKind, WorkerOutcome, WorkersPort, WorkerStartRequest } from "../packages/research/src/tools/types.js";

export interface FakeStart {
  id: string;
  request: WorkerStartRequest;
  /** Settle the worker; defaults to a completed run with the given output. */
  settle(outcome: Partial<WorkerOutcome> & Pick<WorkerOutcome, "output">): void;
}

export interface FakeWorkers {
  port: WorkersPort;
  starts: FakeStart[];
  continues: { childId: string; text: string; parentSessionId: string | undefined }[];
  /** Make the next start fail with this message. */
  failNextStart(message: string): void;
  /** Make the next continuation fail with this message (the child takes no input). */
  failNextContinue(message: string): void;
  /** Hold the next start until `release` is called (a start in flight). */
  holdNextStart(): { release(): void };
}

export const KINDS: WorkerKind[] = [
  { name: "spawn", structured: true, continuable: true, inProcess: true },
  { name: "fork", structured: true, continuable: true, inProcess: true },
  { name: "claude-code", structured: false, continuable: false, inProcess: false },
  { name: "codex", structured: true, continuable: false, inProcess: false },
];

export function fakeWorkers(kinds: WorkerKind[] = KINDS): FakeWorkers {
  const starts: FakeStart[] = [];
  const continues: FakeWorkers["continues"] = [];
  let failure: string | undefined;
  let continueFailure: string | undefined;
  let gate: Promise<void> | undefined;
  return {
    starts,
    continues,
    failNextStart: (message) => {
      failure = message;
    },
    failNextContinue: (message) => {
      continueFailure = message;
    },
    holdNextStart: () => {
      let release!: () => void;
      gate = new Promise<void>((done) => (release = done));
      return { release };
    },
    port: {
      kinds: () => kinds,
      async start(request) {
        if (failure !== undefined) {
          const message = failure;
          failure = undefined;
          throw new Error(message);
        }
        if (gate !== undefined) {
          const held = gate;
          gate = undefined;
          await held;
        }
        const id = `child-${starts.length + 1}`;
        let settle!: (outcome: WorkerOutcome) => void;
        const result = new Promise<WorkerOutcome>((done) => (settle = done));
        starts.push({ id, request, settle: (outcome) => settle({ stopReason: "completed", ...outcome }) });
        return { id, result };
      },
      async continue(childId, text, parentSessionId) {
        if (continueFailure !== undefined) {
          const message = continueFailure;
          continueFailure = undefined;
          throw new Error(message);
        }
        continues.push({ childId, text, parentSessionId });
      },
    },
  };
}
