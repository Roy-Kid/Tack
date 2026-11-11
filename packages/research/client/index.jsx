import React, { useEffect, useState } from "react";
import Composer from "./composer.jsx";
import { act, poll, readBinding, nodePageUrl, readMap, readNode, readSnapshot } from "./api.js";
import MapView from "./map-view.jsx";
import { DecisionCard } from "./panels.jsx";
import { PlanView, RecordsView } from "./records-view.jsx";
import ReplayPanel from "./replay.jsx";
import { Empty, Icon, Segments } from "./ui.jsx";
import "./fonts.css";
import "./workspace.css";

const BINDING_EVERY = 10000;
const SNAPSHOT_EVERY = 15000;
const MAP_EVERY = 30000;
const VIEWS = [["map", "Map"], ["timeline", "Timeline"], ["plan", "Plan"]];
const viewTitles = Object.fromEntries(VIEWS);
const WORKBENCH_SLOT = "tack.research.workbench";

const sameBinding = (a, b) => a !== null && b !== null && a.sessionId === b.sessionId && a.delegation === b.delegation && a.name === b.name && a.scope === b.scope;

/** Opens the workbench only for a conversation that carries a durable experiment marker. */
function ResearchWorkbenchGate({ useSessions, showConversation, renderFactorySlot }) {
  const sessionId = useSessions(list => Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id);
  const running = useSessions(list => sessionId ? list.byId[sessionId]?.running : false);
  const [binding, setBinding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!sessionId) { setBinding(null); setLoading(false); return undefined; }
    setBinding(current => current?.sessionId === sessionId ? current : null); setLoading(true);
    return poll(signal => readBinding(sessionId, signal), BINDING_EVERY,
      value => { setBinding(current => sameBinding(current, value) ? current : value); setError(""); setLoading(false); },
      // A failed poll keeps the workbench open: only an answer that says "not bound" closes it.
      cause => { setError(cause.message); setLoading(false); });
  }, [sessionId, running]);
  const bound = binding && binding.sessionId === sessionId;
  return <div className="tw-workspace">{bound
    ? <Workbench key={`${binding.sessionId}:${binding.delegation}`} binding={binding} showConversation={showConversation} renderFactorySlot={renderFactorySlot} />
    : <Empty title={loading ? "Loading experiment" : "Research workbench"}>{error || (loading ? "Checking the selected conversation's experiment marker." : "Select a conversation linked to an experiment to open its workbench.")}</Empty>}</div>;
}

function Workbench({ binding, showConversation, renderFactorySlot }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [mapped, setMapped] = useState(null);
  const [mapError, setMapError] = useState("");
  const [view, setView] = useState("map");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => poll(signal => readSnapshot(binding, signal), SNAPSHOT_EVERY,
    value => { setSnapshot(value); setError(""); },
    cause => { if (cause.status === 404 || cause.status === 409) showConversation(); else setError(cause.message); }), [binding, reload]);
  useEffect(() => poll(signal => readMap(binding, signal), MAP_EVERY,
    value => { setMapped(value); setMapError(""); },
    cause => setMapError(cause.message)), [binding, reload]);

  if (replaying) return <ReplayPanel sessionId={binding.sessionId} delegation={binding.delegation} scopeName={binding.name} onClose={() => setReplaying(false)} />;
  const record = snapshot?.item.record;
  const gate = snapshot?.item.gate;
  const message = error || notice;
  const run = async (action, answers) => { await act(snapshot, action, answers); setReload(count => count + 1); };
  const guarded = action => () => { run(action).catch(cause => setNotice(cause.message)); };
  return <div className="tw-stage">
    <div className="tw-view">
      {view === "map" && <MapView map={mapped?.map ?? null} current={mapped?.current ?? null} error={mapError} record={record} gate={gate} loadNode={(path, signal) => readNode(binding, path, signal)} onOpenPage={path => window.open(nodePageUrl(binding, path), "_blank", "noopener")} onPause={guarded("pause")} onResume={guarded("resume")} />}
      {view !== "map" && !snapshot && <Empty title={error ? "The experiment could not be read" : "Loading the experiment"}>{error || "Reading this conversation's experiment from Molab."}</Empty>}
      {view === "plan" && snapshot && <PlanView binding={binding} snapshot={snapshot} />}
      {view === "timeline" && snapshot && <RecordsView binding={binding} record={record} onReplay={binding.scope.includes("experiment/") ? () => setReplaying(true) : undefined} />}
    </div>
    <nav className="tw-pill tw-crumbs" aria-label="Workbench location">
      <button aria-label="Back to conversation" title="Back to conversation" onClick={showConversation}>←</button>
      <strong>{binding.name}</strong>
      {view !== "map" && <><span>/</span><span className="tw-ink">{viewTitles[view]}</span></>}
    </nav>
    <div className="tw-pill tw-views">
      <span className={`tw-live ${error ? "is-down" : ""}`} aria-hidden="true" />
      <span className="tw-muted">{error ? "Offline" : record ? "Live" : "Connecting"}</span>
      <i className="tw-rule" />
      <Segments label="Workbench view" values={VIEWS} value={view} onChange={next => { setView(next); setNotice(""); }} />
    </div>
    {message && <div className={`tw-pill tw-notice ${error ? "tw-red" : ""}`} role="status"><span>{message}</span><button onClick={() => { setNotice(""); if (error) setReload(count => count + 1); }}>{error ? "Retry" : "Dismiss"}</button></div>}
    {gate && <DecisionCard key={snapshot.item.digest} gate={gate} onApprove={answers => run("approve", answers)} onAnswer={answers => run("answer", answers)} onDiscuss={showConversation} onReadPlan={() => setView("plan")} />}
    <Composer renderFactorySlot={renderFactorySlot} />
  </div>;
}

export const inject = ["slots", "layout"];
/** The main-slot entry: its one child slot carries the selected conversation's session, which the composer needs. */
function ResearchMain({ renderSlot }) { return renderSlot(WORKBENCH_SLOT, {}); }

export function apply(ctx) {
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "tack-research", children: { [WORKBENCH_SLOT]: { kind: "single", scope: "session-maybe" } } }, ResearchMain));
  ctx.slots.inject(WORKBENCH_SLOT, () => ctx.slots.register({ name: WORKBENCH_SLOT, inject: () => ({ showConversation: () => ctx.layout.selectPanel(null) }) }, ResearchWorkbenchGate));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "tack-research", label: "Research", order: 11 }, () => <Icon />));
}
