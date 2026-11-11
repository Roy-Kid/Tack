import React from "react";
import workflowIcon from "./assets/workflow.svg";

export const stateLabels = { open: "Active", blocked: "Needs you", waiting: "Waiting on compute", paused: "Paused", done: "Completed", stopped: "Stopped" };
export const stateTones = { open: "blue", blocked: "amber", waiting: "blue", paused: "muted", done: "green", stopped: "muted" };
export const stageLabels = { done: "Done", blocked: "Needs you", active: "In progress", open: "Not started" };
export const stageTones = { done: "green", blocked: "amber", active: "blue", open: "muted" };

/** How the state of the reasoning reads: a Hypothesis's verdict, a Decision's status. */
export const reasoningLabels = { Hypothesis: { open: "Being tested", supported: "Supported", refuted: "Refuted", unsettled: "Unsettled" }, Decision: { open: "Needs you", made: "Decided" } };
export const reasoningTones = { Hypothesis: { open: "blue", supported: "green", refuted: "red", unsettled: "muted" }, Decision: { open: "amber", made: "ink" } };
export const reasoningLabel = node => reasoningLabels[node.cls]?.[node.state] ?? node.state;
export const reasoningTone = node => reasoningTones[node.cls]?.[node.state] ?? "muted";

export function Icon({ src = workflowIcon }) { return <img className="tw-icon" src={src} alt="" draggable="false" />; }

export function Button({ children, tone, className = "", ...props }) {
  return <button type="button" className={`tw-button ${tone ? `tw-button-${tone}` : ""} ${className}`} {...props}>{children}</button>;
}

export function Tag({ tone = "muted", children }) { return <span className={`tw-tag tw-${tone}`}>{children}</span>; }

export function Dot({ tone = "muted", shape = "dot" }) { return <i className={`tw-${shape} tw-bg-${tone}`} aria-hidden="true" />; }

export function Fields({ rows }) {
  return <dl className="tw-fields">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}

/** A floating card over the canvas. */
export function Card({ className = "", label, children, ...props }) {
  return <section className={`tw-card ${className}`} aria-label={label} {...props}>{children}</section>;
}

export function Empty({ title, children }) {
  return <div className="tw-empty"><Icon /><h2>{title}</h2><p>{children}</p></div>;
}

/** A segmented switch: arrow keys, Home and End move between segments. */
export function Segments({ values, value, onChange, label }) {
  return <div className="tw-segments" role="tablist" aria-label={label} onKeyDown={(event) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = values.findIndex(([id]) => id === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + values.length) % values.length;
    onChange(values[next][0]); event.currentTarget.children[next].focus();
  }}>{values.map(([id, title]) => <button key={id} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1} onClick={() => onChange(id)}>{title}</button>)}</div>;
}
