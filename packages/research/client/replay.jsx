import React, { useCallback, useEffect, useRef, useState } from "react";
import "./replay.css";

const labels = { experiment: "Experiment", run: "Run", execution: "Execution", knowledge: "Plans and decisions", asset: "Artifact", history: "Other records" };
const stamp = value => new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });

/** Read-only playback of actual Molab records, independent of the design examples. */
export default function ReplayPanel({ onClose, scopeName, sessionId, delegation }) {
  const [events, setEvents] = useState([]);
  const [page, setPage] = useState(null);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState("");
  const request = useRef(null);
  const documentRequest = useRef(null);
  const visible = events.filter(event => `${event.title} ${event.action} ${JSON.stringify(event.details)}`.toLowerCase().includes(query.toLowerCase()));
  const index = Math.min(cursor, Math.max(0, visible.length - 1));
  const step = visible[index];

  const load = useCallback(async (previous = null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setPlaying(false); setError("");
    const params = new URLSearchParams({ replay: "1", limit: "100", session: sessionId, delegation });
    if (kind) params.set("kind", kind);
    if (previous) { params.set("offset", String(previous.nextOffset)); params.set("asOf", previous.asOf); }
    try {
      const response = await fetch(`api/tack/research?${params}`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Replay service returned ${response.status}`);
      if (!controller.signal.aborted) {
        setPage(result); setEvents(old => previous ? [...old, ...result.events] : result.events);
        if (!previous) setCursor(0);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [kind, sessionId, delegation]);
  useEffect(() => { setEvents([]); setPage(null); void load(); return () => request.current?.abort(); }, [load]);
  useEffect(() => () => documentRequest.current?.abort(), []);
  useEffect(() => {
    documentRequest.current?.abort(); setVersion(null); setVersionLoading(false); setVersionError("");
  }, [step?.id]);
  useEffect(() => {
    if (!playing) return;
    if (index >= visible.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => setCursor(value => value + 1), 1500);
    return () => clearTimeout(timer);
  }, [playing, index, visible.length]);

  const readVersion = async () => {
    documentRequest.current?.abort();
    const controller = new AbortController(); documentRequest.current = controller;
    setPlaying(false); setVersionLoading(true); setVersionError("");
    try {
      const params = new URLSearchParams({ replay: "1", document: step.document, commit: step.commit, session: sessionId, delegation });
      const response = await fetch(`api/tack/research?${params}`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "This historical version is unavailable");
      if (!controller.signal.aborted) setVersion(result);
    } catch (cause) { if (!controller.signal.aborted) setVersionError(cause.message); }
    finally { if (!controller.signal.aborted) setVersionLoading(false); }
  };

  return <section className="rp" aria-label="Experiment replay">
    <header className="rp-heading"><div><h1>Experiment replay</h1><p>Review recorded experiments, failures, recovery and decisions.</p><p>Source: {scopeName || "This experiment"} · Saved records</p></div><div className="rp-actions">
      <button disabled={loading} onClick={() => void load()}>{loading ? "Loading…" : "Refresh replay"}</button>
      {onClose && <button onClick={onClose}>Back to workbench</button>}
    </div></header>
    <div className="rp-filters"><label>Record type<select value={kind} onChange={event => { setKind(event.target.value); setPlaying(false); }}>
      <option value="">All records</option>{Object.entries(labels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
    </select></label><label>Search loaded records<input type="search" value={query} placeholder="Experiment, parameter or decision reason" onChange={event => { setQuery(event.target.value); setCursor(0); setPlaying(false); }} /></label></div>
    {error && <p role="alert" className="rp-error">Could not load replay: {error}. Check the Molab connection and retry.</p>}
    {page?.warnings.map(warning => <p key={warning} role="status" className="rp-muted">{warning}</p>)}
    <div className="rp-transport">
      <button disabled={!visible.length || index === 0} onClick={() => { setPlaying(false); setCursor(index - 1); }}>Previous</button>
      <button disabled={visible.length < 2} aria-pressed={playing} onClick={() => { if (index >= visible.length - 1) setCursor(0); setPlaying(value => !value); }}>{playing ? "Pause" : "Play"}</button>
      <button disabled={!visible.length || index >= visible.length - 1} onClick={() => { setPlaying(false); setCursor(index + 1); }}>Next</button>
      <label className="rp-scrub">Replay position<input type="range" min={0} max={Math.max(0, visible.length - 1)} value={index} disabled={!visible.length}
        aria-valuetext={step ? `${index + 1}: ${step.title}` : "No records"} onChange={event => { setPlaying(false); setCursor(Number(event.target.value)); }} /></label>
      <span className="rp-position" aria-live={playing ? "off" : "polite"}>{visible.length ? index + 1 : 0} / {visible.length}</span>
    </div>
    {page && <p className="rp-muted">Loaded {events.length} / {page.total} records · Oldest first · As of {stamp(page.asOf)}. Execution times may overlap for parallel runs.</p>}
    {loading && <p role="status">Loading the experiment history…</p>}
    {!loading && !visible.length && !error && <p className="rp-muted">{events.length ? "No loaded records match your search." : "No replay records are available for this experiment."}</p>}
    <div className="rp-grid"><ol className="rp-timeline" aria-label="Experiment event sequence">
      {visible.map((event, order) => <li key={event.id}><button aria-current={step?.id === event.id ? "step" : undefined} onClick={() => { setCursor(order); setPlaying(false); }}>
        <time dateTime={event.at}>{stamp(event.at)}</time><strong>{event.title}</strong><small>{labels[event.kind] ?? event.kind} · {event.action}</small>
      </button></li>)}
    </ol>{step && <article className="rp-record" aria-label="Selected replay step">
      <time dateTime={step.at}>{stamp(step.at)}</time><h2>{step.title}</h2><p className="rp-muted">{step.action}{step.actor ? ` · ${step.actor.name || step.actor.id}` : ""}</p>
      {step.ref && <p className="rp-ref">{step.ref}</p>}
      {step.details.reason && <p>{step.details.reason}</p>}
      {step.details.mode && <p>Execution mode: {step.details.mode}{step.details.basedOnExecutionId ? `; based on ${step.details.basedOnExecutionId}` : ""}</p>}
      {step.details.currentVersion && <p className="rp-muted">This artifact entry describes its current registered version.</p>}
      <details><summary>Parameters and evidence</summary><pre>{JSON.stringify(step.details, null, 2)}</pre></details>
      {step.document && step.commit && <button disabled={versionLoading} onClick={() => void readVersion()}>{versionLoading ? "Loading historical version…" : "Read historical document"}</button>}
      {step.commit && <p className="rp-ref">Record version {step.commit.slice(0, 12)}</p>}
      {versionError && <p className="rp-error" role="alert">{versionError}</p>}
      {version && <section aria-label="Historical document version"><h3>{version.name}</h3><pre>{version.body}</pre></section>}
    </article>}</div>
    {page && page.nextOffset !== null && <button disabled={loading} onClick={() => void load(page)}>Load more records</button>}
  </section>;
}
