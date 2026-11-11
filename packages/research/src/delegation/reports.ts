/**
 * Filing a worker's report: parse what the provider returned, keep it as a
 * molab Report (record kind `worker_report`, authored by the worker), link it
 * to its attempt, and merge every capability gap it names into the workspace's
 * capability-gaps Todo. A report is accepted only while `molab validate
 * --new-only` finds no error: otherwise the attempt carries the errors as its
 * check and the worker is asked to fix them.
 * A report that is missing or invalid leaves a `check` on the attempt instead,
 * with the problems, so the supervisor reads the outputs only then.
 *
 * Idempotent per attempt: the attempt's `report` and the delegation's write
 * log both stop a second filing. Links in flight are tracked so a reader
 * woken by DSH's settlement can wait for the filing to land.
 */
import { MolabError } from "../molab/client.js";
import type { ValidationRow } from "../molab/schemas.js";
import { fileCapabilityGaps } from "../tools/decisions.js";
import { docName, hostOf, writeCited, writeOnce } from "../tools/records.js";
import type { ResearchDeps, WorkerOutcome } from "../tools/types.js";
import { clip, errorMessage } from "../text.js";
import { type EndedHook, WORKSPACE_INVALID } from "../workers.js";
import { type Attempt, linkReport, settleAttempt, toWire } from "./model.js";
import { parseWorkerReport, type WorkerReport, WorkerReportRecord } from "./report.js";
import type { StoredDelegation } from "./store.js";

const CHECK_CHARS = 500;
const SUMMARY_CHARS = 500;
const reportKey = (attemptId: string) => `worker-report:${attemptId}`;

export type LinkResult =
  | { linked: true; attempt: string; report: string; reused: boolean; parsed: WorkerReport }
  | { linked: false; attempt: string; check: string; problems: string[] };

// ── Filings in flight ────────────────────────────────────────────────────────

/** A worker whose result is awaited and, once it arrives, the filing that follows. */
interface Pending {
  arrived: Promise<void>;
  filing?: Promise<unknown>;
}

/** Pending results and filings, per plugin instance (its deps) and delegation. */
const pending = new WeakMap<ResearchDeps, Map<string, Set<Pending>>>();

/** How long a reader waits for a result that DSH has settled but not yet handed over. */
const ARRIVAL_GRACE_MS = 3_000;

/**
 * Register a worker's pending result and the filing that follows it, so a
 * reader woken by DSH's settlement can wait for the report to land. Returns
 * the filing's outcome (rejects when the result or the filing fails).
 */
export function trackLink<O, T>(deps: ResearchDeps, delegationPath: string, result: Promise<O>, file: (outcome: O) => Promise<T>): Promise<T> {
  const byPath = pending.get(deps) ?? new Map<string, Set<Pending>>();
  pending.set(deps, byPath);
  const set = byPath.get(delegationPath) ?? new Set<Pending>();
  byPath.set(delegationPath, set);
  let arrive!: () => void;
  const entry: Pending = { arrived: new Promise<void>((done) => (arrive = done)) };
  set.add(entry);
  // The filing is attached before `arrived` resolves, so a reader that saw the arrival sees the filing.
  const filing = result.then((outcome) => {
    const work = file(outcome);
    entry.filing = work;
    return work;
  });
  result.then(arrive, arrive);
  const forget = () => set.delete(entry);
  filing.then(forget, forget);
  return filing;
}

/**
 * Wait for every filing in flight for `delegationPath`: one whose result has
 * arrived, until it lands; one whose result is still due, for a short grace
 * (DSH settles a child and notifies the parent before the result resolves).
 * A worker still at work is left alone. Failures are the filings' to log.
 */
export async function settledLinks(deps: ResearchDeps, delegationPath: string, graceMs = ARRIVAL_GRACE_MS): Promise<void> {
  const set = pending.get(deps)?.get(delegationPath);
  if (set === undefined || set.size === 0) return;
  const grace = new Promise<void>((done) => setTimeout(done, graceMs).unref());
  await Promise.all(
    [...set].map(async (entry) => {
      await Promise.race([entry.arrived, grace]);
      if (entry.filing !== undefined) await entry.filing.then(() => undefined, () => undefined);
    }),
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** A filed worker report, validated. */
export async function readWorkerReport(deps: ResearchDeps, path: string, signal?: AbortSignal): Promise<WorkerReportRecord> {
  const doc = await deps.molab.getRecord(path, signal);
  if (doc.cls !== "Report") throw new Error(`${path} is a ${doc.cls}, not a Report`);
  const parsed = WorkerReportRecord.safeParse(doc.record);
  if (!parsed.success) {
    throw new Error(`${path} is not a worker report: ${parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "record"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function renderReport(attempt: Attempt, delegationPath: string, report: WorkerReport, unverified: string | undefined): string {
  const checks = Object.entries(report.checks);
  return [
    `# Worker report: ${attempt.id}`,
    "",
    `Delegation: ${delegationPath} · Attempt: ${attempt.id} · Worker: ${attempt.worker} · Outcome: **${report.outcome}**`,
    "",
    `Brief: ${attempt.brief ?? "(none)"}${attempt.brief_digest ? ` (sha256 ${attempt.brief_digest})` : ""}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Checks",
    "",
    ...(checks.length === 0
      ? ["- (none reported)"]
      : ["| check | verdict | value | note |", "| --- | --- | --- | --- |", ...checks.map(([name, check]) => `| ${cell(name)} | ${check.verdict} | ${check.value === undefined || check.value === null ? "" : cell(String(check.value))} | ${cell(check.note ?? "")} |`)]),
    "",
    "## Products",
    "",
    ...(report.products.length === 0 ? ["- (none)"] : report.products.map((product) => `- ${product.path} (${product.kind})${product.description ? `: ${product.description}` : ""}`)),
    ...(unverified !== undefined ? ["", `Molab could not verify the products as workspace files: ${unverified}`] : []),
    "",
    "## Files changed",
    "",
    ...(report.files_changed.length === 0 ? ["- (none)"] : report.files_changed.map((file) => `- ${file}`)),
    "",
    ...(report.workflow ? ["## Workflow", "", `- ${report.workflow}`, ""] : []),
    "## Protocol deviations",
    "",
    ...(report.protocol_deviations.length === 0
      ? ["- (none)"]
      : ["| item | expected | actual |", "| --- | --- | --- |", ...report.protocol_deviations.map((item) => `| ${cell(item.item)} | ${cell(item.expected)} | ${cell(item.actual)} |`)]),
    "",
    "## Capability gaps",
    "",
    ...(report.capability_gaps.length === 0 ? ["- (none)"] : report.capability_gaps.map((gap) => `- ${gap.component}: ${gap.title}${gap.version ? ` (${gap.version})` : ""} — ${gap.repro}${gap.fix ? `; fix: ${gap.fix}` : ""}`)),
    "",
    "## Open questions",
    "",
    ...(report.open_questions.length === 0 ? ["- (none)"] : report.open_questions.map((question) => `- ${question}`)),
    "",
    ...(report.next ? ["## Next", "", report.next, ""] : []),
    `Tokens: ${report.tokens === "unavailable" ? "unavailable" : JSON.stringify(report.tokens)}`,
    "",
  ].join("\n");
}

// ── Filing ───────────────────────────────────────────────────────────────────

/**
 * The Report document, citing the products as workspace files when molab
 * accepts them; a product molab cannot find does not block the filing, it
 * is noted in the body.
 */
async function writeReportDoc(deps: ResearchDeps, current: StoredDelegation, attempt: Attempt, report: WorkerReport): Promise<{ relPath: string }> {
  const brief = attempt.brief;
  const digest = attempt.brief_digest;
  if (brief === undefined || brief === null || digest === undefined || digest === null) {
    throw new Error(`attempt ${attempt.id} has no brief: it was not started by research_dispatch, so its report cannot be filed`);
  }
  const record = toWire({ kind: "worker_report", delegation: current.path, attempt: attempt.id, brief, brief_digest: digest, ...report });
  const write = (products: readonly string[], unverified: string | undefined) =>
    writeCited(
      deps,
      {
        name: docName("worker-report", attempt.id, deps.now()),
        cls: "Report",
        hostPath: hostOf(current.path),
        body: renderReport(attempt, current.path, report, unverified),
        record,
        createdBy: attempt.worker,
      },
      [...products, brief, current.path],
      current.record.scope,
      "derived_from",
    );
  const products = report.products.map((product) => product.path);
  try {
    return await write(products, undefined);
  } catch (error) {
    if (!(error instanceof MolabError && error.status === 422) || products.length === 0) throw error;
    return write([], error.detail);
  }
}

function attemptOf(current: StoredDelegation, attemptId: string): Attempt {
  const attempt = current.record.attempts.find((existing) => existing.id === attemptId);
  if (attempt === undefined) throw new Error(`no attempt ${attemptId} on ${current.path}`);
  return attempt;
}

/**
 * File the report a worker returned and link it to its attempt. A second
 * call for the same attempt returns the first filing.
 */
export async function linkWorkerReport(deps: ResearchDeps, delegationPath: string, attemptId: string, outcome: WorkerOutcome): Promise<LinkResult> {
  const current = await deps.store.get(delegationPath);
  const attempt = attemptOf(current, attemptId);
  if (attempt.report !== undefined && attempt.report !== null) {
    return { linked: true, attempt: attemptId, report: attempt.report, reused: true, parsed: await readWorkerReport(deps, attempt.report) };
  }
  const endedAt = deps.now().toISOString();
  const parsed = parseWorkerReport(outcome.structured ?? outcome.output);
  if (!parsed.ok) {
    const kind = outcome.structured === undefined && outcome.output.trim() === "" ? "unreported" : "invalid";
    const ended = outcome.stopReason === "completed" ? "" : ` (the worker ended with ${outcome.stopReason}${outcome.diagnostic ? `: ${outcome.diagnostic}` : ""})`;
    const check = clip(`${kind}: ${parsed.problems.join("; ")}${ended}`, CHECK_CHARS);
    await deps.store.update(delegationPath, (record) =>
      settleAttempt(linkReport(record, attemptId, { check }), attemptId, { status: outcome.stopReason, summary: clip(outcome.output.trim(), SUMMARY_CHARS), ended_at: endedAt }),
    );
    return { linked: false, attempt: attemptId, check, problems: parsed.problems };
  }
  const report = parsed.report;
  // Gate: a turn that leaves the workspace invalid is not accepted; the worker hears the errors.
  const invalid = await newWorkspaceErrors(deps);
  if (invalid.length > 0) {
    const problems = invalid.map((row) => `${row.rule} ${row.path}: ${row.detail}`);
    const check = clip(`${WORKSPACE_INVALID} (molab validate --new-only): ${problems.join("; ")}`, CHECK_CHARS);
    await deps.store.update(delegationPath, (record) =>
      settleAttempt(linkReport(record, attemptId, { check }), attemptId, { status: outcome.stopReason, summary: clip(report.summary, SUMMARY_CHARS), ended_at: endedAt }),
    );
    return { linked: false, attempt: attemptId, check, problems };
  }
  const doc = await writeOnce(deps, delegationPath, reportKey(attemptId), () => writeReportDoc(deps, current, attempt, report));
  // The report's summary replaces the final text the runtime's end event may already have recorded.
  const summary = clip(report.summary, SUMMARY_CHARS);
  await deps.store.update(delegationPath, (record) =>
    settleAttempt(linkReport(doc.remember(record), attemptId, { report: doc.relPath, summary, tokens: report.tokens, files_changed: report.files_changed }), attemptId, {
      status: outcome.stopReason,
      summary,
      ended_at: endedAt,
    }),
  );
  if (report.capability_gaps.length > 0) await fileCapabilityGaps(deps, report.capability_gaps, doc.relPath, current.record.scope);
  return { linked: true, attempt: attemptId, report: doc.relPath, reused: doc.reused, parsed: report };
}

/**
 * The errors `molab validate --new-only` reports for the served workspace.
 * Validation that cannot run is an error of its own: the gate does not pass
 * a turn it could not check.
 */
async function newWorkspaceErrors(deps: ResearchDeps): Promise<ValidationRow[]> {
  try {
    return (await deps.validate()).filter((row) => row.severity === "error");
  } catch (error) {
    return [{ path: "(workspace)", rule: "validate.unavailable", detail: errorMessage(error), severity: "error", hint: "" }];
  }
}

/**
 * The ledger's end hook: a continued worker has no result promise, so its
 * report is filed from its final text when it ends, tracked so a reader woken
 * by the settlement can wait for it. `deps` is read late: the ledger is built
 * before the deps that hold it.
 */
export function fileOnEnd(deps: () => ResearchDeps): EndedHook {
  return (delegation, attemptId, end) =>
    trackLink(deps(), delegation, Promise.resolve(end), (ended) => linkWorkerReport(deps(), delegation, attemptId, { output: ended.output ?? "", stopReason: ended.stopReason })).then(
      (result) => result.linked,
    );
}

/**
 * Link a Report document that already exists (filed by the result handler,
 * or by hand) to its attempt: the pull side of filing, for a supervisor who
 * names the path. Returns the attempt and the validated report.
 */
export async function linkReportDoc(deps: ResearchDeps, delegationPath: string, reportPath: string, signal?: AbortSignal): Promise<{ attempt: Attempt; report: WorkerReportRecord; reused: boolean }> {
  const report = await readWorkerReport(deps, reportPath, signal);
  if (report.delegation !== delegationPath) throw new Error(`${reportPath} reports on delegation ${report.delegation}, not ${delegationPath}`);
  const current = await deps.store.get(delegationPath, signal);
  const attempt = attemptOf(current, report.attempt);
  if (attempt.report !== undefined && attempt.report !== null) {
    if (attempt.report !== reportPath) throw new Error(`attempt ${attempt.id} is already linked to ${attempt.report}; ${reportPath} is a second report for it (retract one with research_retract)`);
    return { attempt, report, reused: true };
  }
  const invalid = await newWorkspaceErrors(deps);
  if (invalid.length > 0) {
    throw new Error(
      `${reportPath} is not accepted: the workspace has new validation errors (molab validate --new-only): ${invalid.map((row) => `${row.rule} ${row.path}: ${row.detail}`).join("; ")}. Have the worker fix them (research_dispatch continuing its attempt), then assess again.`,
    );
  }
  // A filed report means the worker finished its round, whether or not its end event was seen.
  const summary = clip(report.summary, SUMMARY_CHARS);
  const stored = await deps.store.update(delegationPath, (record) =>
    settleAttempt(linkReport(record, attempt.id, { report: reportPath, summary, tokens: report.tokens, files_changed: report.files_changed }), attempt.id, {
      status: "completed",
      summary,
      ended_at: deps.now().toISOString(),
    }),
  );
  return { attempt: attemptOf(stored, attempt.id), report, reused: false };
}
