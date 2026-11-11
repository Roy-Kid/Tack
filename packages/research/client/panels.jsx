import React, { useEffect, useState } from "react";
import { Button, Card, Dot, Tag, stageLabels, stageTones, stateLabels, stateTones, reasoningLabel, reasoningTone } from "./ui.jsx";

const itemTones = { done: "green", blocked: "amber", open: "muted" };
const gateNames = { parameters: "Parameters", plan: "Plan", dry_run: "Dry run", results: "Results" };

function Head({ tag, tone, title, onClose }) {
  return <><div className="tw-row"><Tag tone={tone}>{tag}</Tag><span className="tw-grow" /><button className="tw-close" aria-label="Close details" onClick={onClose}>✕</button></div><h2 className="tw-serif">{title}</h2></>;
}

function Section({ title, children }) { return <div className="tw-section"><h3 className="tw-eyebrow">{title}</h3>{children}</div>; }

function Link({ children, onClick }) { return <button className="tw-link" onClick={onClick}>{children}</button>; }

const GATES = ["parameters", "plan", "dry_run", "results"];
const budgetLabels = { worker_runs: "Worker rounds", worker_usd: "Worker cost, USD", executions: "Executions", wall_hours: "Wall hours" };

/** The four human gates in the order an experiment meets them: approved, waiting for a person, or not reached. */
function Gates({ record, gate }) {
  return <ol className="tw-gates" aria-label="Human gates">{GATES.map(name => {
    const state = record.approvals.some(approval => approval.gate === name) ? "done" : gate?.gate === name ? "ask" : "todo";
    return <li key={name} className={`is-${state}`}><i aria-hidden="true">{state === "done" ? "✓" : ""}</i>{gateNames[name]}<span className="tw-sr">{state === "done" ? " approved" : state === "ask" ? " waiting for you" : " not reached"}</span></li>;
  })}</ol>;
}

/** What is happening now, and what is waiting for a person. Shown while nothing is selected. */
export function NowCard({ map, record, gate, onSelect, onPause, onResume }) {
  const done = map.stages.filter(stage => stage.status === "done").length;
  const waiting = map.attention.length + (record?.state === "blocked" ? 1 : 0);
  const budget = record ? Object.keys(budgetLabels).filter(key => record.budget[key] != null) : [];
  // Progress first: the card opens as one line, and shows what is behind it when asked.
  const [open, setOpen] = useState(false);
  return <Card className="tw-now" label="Current status">
    <div className="tw-row"><span className="tw-eyebrow">Now</span><span className="tw-grow" />{map.milestones.total > 0 && <span className="tw-mono tw-muted">Milestones {map.milestones.met} / {map.milestones.total}</span>}</div>
    <button className="tw-now-headline" aria-expanded={open} onClick={() => setOpen(value => !value)}><h2 className="tw-serif">{done} of {map.stages.length} stages done · {waiting === 0 ? "nothing waiting" : `${waiting} waiting for you`}</h2><span aria-hidden="true">{open ? "▾" : "▸"}</span></button>
    {open && <>
    {record && <>
      <div className="tw-kv"><span className="tw-row"><Dot tone={stateTones[record.state]} />This conversation’s experiment</span><span className={`tw-${stateTones[record.state]}`}>{stateLabels[record.state]}</span></div>
      <Gates record={record} gate={gate} />
      {budget.map(key => <div className="tw-kv" key={key}><span>{budgetLabels[key]}</span><span className="tw-mono">{record.spent[key] ?? 0} / {record.budget[key]}</span></div>)}
      {["open", "waiting"].includes(record.state) && <div className="tw-row"><Button onClick={onPause}>Pause</Button></div>}
      {record.state === "paused" && <div className="tw-row"><Button tone="blue" onClick={onResume}>Resume</Button></div>}
    </>}
    {map.attention.map(item => <div className="tw-kv" key={item.id}><span className="tw-row"><Dot tone="amber" />{item.title}</span>{item.node && <Link onClick={() => onSelect(item.node)}>Open ›</Link>}</div>)}
    {map.unreadable.length > 0 && <p className="tw-hint">{map.unreadable.length} planning document{map.unreadable.length === 1 ? "" : "s"} could not be read and {map.unreadable.length === 1 ? "is" : "are"} missing from this map.</p>}
    </>}
  </Card>;
}

const roleLabels = { derived_from: "Derived from", supersedes: "Supersedes", supports: "Supports", contradicts: "Contradicts", cites: "Cites", records: "Records", references: "Refers to" };
const backLabels = { derived_from: "Source of", supersedes: "Superseded by", supports: "Supported by", contradicts: "Contradicted by", cites: "Cited by", records: "Recorded by", references: "Referred to by" };

/** The arrows at one document: what it refers to and what refers to it, each with the role the link declares. */
function Links({ node, map, onOpen }) {
  const title = id => map.nodes.find(entry => entry.id === id)?.title ?? id;
  const refersTo = map.edges.filter(edge => edge.from === node.id);
  const referredBy = map.edges.filter(edge => edge.to === node.id);
  return <>
    {refersTo.length > 0 && <Section title={`Refers to · ${refersTo.length}`}>{refersTo.map(edge => <div className="tw-kv" key={`${edge.to}:${edge.role}`}><span>{roleLabels[edge.role] ?? edge.role}</span><Link onClick={() => onOpen(edge.to)}>{title(edge.to)} ›</Link></div>)}</Section>}
    {referredBy.length > 0 && <Section title={`Referred to by · ${referredBy.length}`}>{referredBy.map(edge => <div className="tw-kv" key={`${edge.from}:${edge.role}`}><span>{backLabels[edge.role] ?? edge.role}</span><Link onClick={() => onOpen(edge.from)}>{title(edge.from)} ›</Link></div>)}</Section>}
    {node.refs.length > 0 && <Section title={`Workspace and outside · ${node.refs.length}`}>{node.refs.slice(0, 8).map(ref => <div className="tw-kv" key={`${ref.target}:${ref.role}`}><span>{roleLabels[ref.role] ?? ref.role}</span><span className="tw-path">{ref.target}</span></div>)}{node.refs.length > 8 && <p className="tw-hint">and {node.refs.length - 8} more</p>}</Section>}
    {refersTo.length + referredBy.length + node.refs.length === 0 && <p className="tw-muted">This document refers to nothing, and nothing on the map refers to it.</p>}
  </>;
}

function Stages({ stages }) {
  return <Section title={`Stages · ${stages.length}`}>{stages.map(stage => <div className="tw-stage-row" key={stage.id}>
    <div className="tw-kv"><span className="tw-row"><Dot tone={stageTones[stage.status]} /><span className="tw-ink">{stage.title || stage.id}</span></span><span className={`tw-${stageTones[stage.status]}`}>{stageLabels[stage.status]}{stage.todo.total > 0 && ` · ${stage.todo.done}/${stage.todo.total}`}</span></div>
    {stage.dependsOn.length > 0 && <p className="tw-hint">After {stage.dependsOn.map(id => stages.find(entry => entry.id === id)?.title || id).join(", ")}</p>}
    {stage.experiment && <p className="tw-hint">Runs in experiment {stage.experiment}</p>}
  </div>)}</Section>;
}

/** A preview of one knowledge document: what its record says, the references it makes and receives, and its text. */
export function DocumentPanel({ node, map, current, load, onOpen, onOpenPage, onClose }) {
  const [body, setBody] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    load(node.id, controller.signal).then(value => { if (!controller.signal.aborted) setBody(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [node.id]);
  const stages = node.cls === "Roadmap" ? map.stages.filter(stage => stage.roadmap === node.id) : [];
  const closes = node.cls === "Milestone" ? map.stages.find(stage => stage.milestone?.path === node.id) : undefined;
  const items = node.cls === "Todo" ? map.stages.flatMap(stage => stage.items) : closes?.items ?? [];
  return <Card className="tw-panel tw-panel-wide" label={node.cls}>
    <Head tag={node.cls} tone={node.state ? reasoningTone(node) : stageTones[node.status] ?? "ink"} title={node.title} onClose={onClose} />
    <p className="tw-path">{node.id}</p>
    <div className="tw-row tw-wrap"><Button onClick={onOpenPage}>Open page ↗</Button></div>
    {current && <p className="tw-blue">Filed under the experiment this conversation is bound to.</p>}
    {node.status && <p className={`tw-${stageTones[node.status]}`}>{stageLabels[node.status]}{node.note && ` · ${node.note}`}</p>}
    {node.state && <p className={`tw-${reasoningTone(node)}`}>{reasoningLabel(node)}</p>}
    {closes?.milestone && <Section title="Closes when"><p>{closes.milestone.criterion}</p></Section>}
    {stages.length > 0 && <Stages stages={stages} />}
    {items.length > 0 && <Section title={`Work items · ${items.length}`}>{items.map(item => <div className="tw-kv" key={item.id}><span className="tw-row"><Dot tone={itemTones[item.status] ?? "muted"} />{item.title}</span><span className={`tw-${itemTones[item.status] ?? "muted"}`}>{item.status}</span></div>)}</Section>}
    <Links node={node} map={map} onOpen={onOpen} />
    {error ? <p className="tw-red" role="alert">{error}</p> : body === null ? <p className="tw-muted">Loading the document…</p> : <pre className="tw-doc">{body}</pre>}
  </Card>;
}

/** The pending question or gate of this conversation's experiment. Every action goes through the same research tool as the conversation. */
export function DecisionCard({ gate, onApprove, onAnswer, onDiscuss, onReadPlan }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const send = (name, action) => async () => {
    setBusy(name); setError("");
    try { await action(answer); } catch (cause) { setError(cause.message); setBusy(""); }
  };
  return <Card className="tw-decision" label="Decision waiting" role="region">
    <div className="tw-row"><span className="tw-eyebrow tw-amber">{gate.gate ? `${gateNames[gate.gate]} gate` : "Question"}</span><span className="tw-grow" /><span className="tw-muted">Needs you</span></div>
    {gate.questions.length === 0 ? <h2 className="tw-serif">This experiment is waiting for your answer.</h2> : gate.questions.map((question, index) => <h2 className="tw-serif" key={index}>{question}</h2>)}
    {gate.target && <p className="tw-path">{gate.target}</p>}
    <label className="tw-field">{gate.gate ? "Answer, or a note to go with your approval" : "Your answer"}<textarea value={answer} maxLength={2000} disabled={busy !== ""} onChange={event => setAnswer(event.target.value)} /></label>
    {error && <p className="tw-red" role="alert">{error}</p>}
    <div className="tw-row tw-wrap">
      {gate.gate && <Button tone="amber" disabled={busy !== ""} onClick={send("approve", onApprove)}>{busy === "approve" ? "Approving…" : `Approve ${gateNames[gate.gate].toLowerCase()}`}</Button>}
      <Button disabled={busy !== "" || answer.trim() === ""} onClick={send("answer", onAnswer)}>{busy === "answer" ? "Sending…" : "Send answer"}</Button>
      <span className="tw-grow" />
      {gate.gate === "plan" && <Link onClick={onReadPlan}>Read Plan ›</Link>}
      <Link onClick={onDiscuss}>Conversation ›</Link>
    </div>
  </Card>;
}
