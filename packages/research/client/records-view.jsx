import React, { useEffect, useState } from "react";
import { readPlanBody } from "./api.js";
import { Button, Fields, stateLabels } from "./ui.jsx";

function Table({ head, rows, empty }) {
  if (rows.length === 0) return <p className="tw-muted">{empty}</p>;
  return <table><thead><tr>{head.map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(([key, ...cells]) => <tr key={key}>{cells.map((cell, index) => <td key={index}>{cell || "—"}</td>)}</tr>)}</tbody></table>;
}

/** The records Molab holds for this conversation's experiment. Runs, worker rounds and decisions stay separate. */
export function RecordsView({ binding, record, onReplay }) {
  return <div className="tw-page"><article className="tw-sheet">
    <div className="tw-row"><span className="tw-eyebrow">Timeline · this conversation’s experiment</span><span className="tw-grow" />{onReplay && <Button onClick={onReplay}>Replay records</Button>}</div>
    <h1 className="tw-serif">{binding.name}</h1>
    <p>{record.goal}</p>
    <Fields rows={[["State", stateLabels[record.state] ?? record.state], ["Experiment", binding.scope], ["Plan", record.current_plan ?? "Not created"], ["Conversation", binding.sessionId]]} />
    <h2>Runs</h2>
    <Table head={["Object", "Status", "Type", "Next step"]} empty="No linked execution waits have been recorded for this experiment." rows={record.waits.map(wait => [wait.id, wait.target, wait.state, wait.kind, wait.on_resolve])} />
    <h2>Worker rounds</h2>
    <Table head={["Round", "Status", "Task", "Report"]} empty="No worker activity has been recorded for this experiment." rows={record.attempts.map(attempt => [attempt.id, attempt.id, attempt.status, attempt.task, attempt.report])} />
    <h2>Decisions</h2>
    <Table head={["Decision", "Reason", "When"]} empty="No decisions have been recorded for this experiment." rows={record.decisions.map((decision, index) => [index, decision.name, decision.reason, decision.at])} />
    <p className="tw-hint">Worker rounds and execution retries are not research iterations; none are inferred here.</p>
  </article></div>;
}

/** The current Plan document of this conversation's experiment. */
export function PlanView({ binding, snapshot }) {
  const path = snapshot.item.record.current_plan;
  const [body, setBody] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBody(null); setError("");
    if (!path) return undefined;
    const controller = new AbortController();
    readPlanBody(binding, path, controller.signal).then(value => { if (!controller.signal.aborted) setBody(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [binding, path, snapshot.planRevision]);
  return <div className="tw-page"><article className="tw-sheet">
    <span className="tw-eyebrow">Current Plan</span>
    <p className="tw-path">{path ?? "No Plan recorded yet"}</p>
    {error ? <p className="tw-red" role="alert">{error}</p> : body !== null ? <pre>{body}</pre> : <p className="tw-muted">{path ? "Loading Plan…" : "Create a Plan in this conversation to start the experiment."}</p>}
  </article></div>;
}
