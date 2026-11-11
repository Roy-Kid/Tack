import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { WorkflowNodeRenderer, useListenEvents } from "@flowgram.ai/free-layout-editor";
import { MAP_SHAPE_SIZE, foldedReferences, layoutResearchMap } from "../src/map-layout.ts";
import { CanvasContext, GraphCanvas } from "./canvas.jsx";
import { DocumentPanel, NowCard } from "./panels.jsx";
import { Dot, Empty, Tag, reasoningLabel, reasoningTone, stageLabels, stageTones } from "./ui.jsx";

// An arrow leaves the referring document on its left and enters the document referred to on its right: references point back, leftwards.
const PORTS = [{ type: "output", location: "left" }, { type: "input", location: "right" }];
const registries = Object.entries(MAP_SHAPE_SIZE).map(([type, size]) => ({ type, meta: { size, defaultPorts: PORTS } }));
const pillTones = { Finding: "green", Observation: "blue", Literature: "muted" };

/** The map as FlowGram JSON, with each arrow's role and each node's neighbours looked up by id. */
function toGraph(map, current) {
  const placed = new Map(layoutResearchMap(map).map(node => [node.id, node]));
  // Each arrow carries its role, the positions of its two documents, and whether it folds away: enough for CSS alone to fold, reveal and dim arrows without redrawing the canvas.
  const index = new Map(map.nodes.map((node, position) => [node.id, position]));
  const folded = foldedReferences(map);
  const roles = new Map(map.edges.map((edge, position) => [`${edge.from}→${edge.to}`, `tw-role-${edge.role} tw-edge-a${index.get(edge.from)} tw-edge-b${index.get(edge.to)} ${folded[position] ? "tw-edge-folded" : ""}`]));
  const links = new Map(map.nodes.map(node => [node.id, new Set([node.id])]));
  for (const edge of map.edges) { links.get(edge.from)?.add(edge.to); links.get(edge.to)?.add(edge.from); }
  return {
    graph: {
      nodes: map.nodes.flatMap(node => {
        const at = placed.get(node.id);
        return at ? [{ id: node.id, type: at.shape, meta: { position: { x: at.x, y: at.y } }, data: { ...node, current: current !== null && node.host === current } }] : [];
      }),
      edges: map.edges.filter(edge => placed.has(edge.from) && placed.has(edge.to)).map(edge => ({ sourceNodeID: edge.from, targetNodeID: edge.to })),
    },
    roles, links, index, foldedCount: folded.filter(Boolean).length,
  };
}

function Body({ shape, data }) {
  if (shape === "question") return <><span className="tw-eyebrow tw-blue">{data.cls}</span><strong className="tw-serif">{data.title}</strong><small>{data.excerpt}</small></>;
  if (shape === "card" && data.state) return <><div className="tw-row"><Tag tone={reasoningTone(data)}>{data.cls}</Tag></div><strong>{data.title}</strong><small className={`tw-${reasoningTone(data)}`}>{reasoningLabel(data)}</small></>;
  if (shape === "card") return <><div className="tw-row"><Tag tone={stageTones[data.status] ?? "muted"}>{data.cls}</Tag></div><strong>{data.title}</strong><small>{data.status && <span className={`tw-${stageTones[data.status]}`}>{stageLabels[data.status]}{data.note && " · "}</span>}{data.note}</small></>;
  return <div className="tw-row"><Dot tone={pillTones[data.cls] ?? "muted"} shape="diamond" /><span>{data.title}</span></div>;
}

function MapNode({ node }) {
  const { selected, select, open, isDim } = useContext(CanvasContext);
  useListenEvents(node.onExtInfoChange);
  const data = node.getExtInfo();
  const shape = node.flowNodeType;
  return <WorkflowNodeRenderer node={node} className={`tw-map-node tw-map-${shape} ${data.status ? `is-${data.status}` : ""} ${data.state ? `is-${data.cls.toLowerCase()}-${data.state}` : ""} ${data.current ? "is-current" : ""} ${selected === node.id ? "is-selected" : ""} ${isDim(node.id) ? "is-dim" : ""}`} portClassName="tw-map-port">
    <div role="button" tabIndex={0} aria-label={`${data.cls}: ${data.title}`} aria-pressed={selected === node.id} className="tw-map-content" title="Click to preview · double-click to open the page" onClick={(event) => { event.stopPropagation(); select(node.id); }} onDoubleClick={(event) => { event.stopPropagation(); open(node.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node.id); } }}>
      <Body shape={shape} data={data} />
    </div>
  </WorkflowNodeRenderer>;
}

export default function MapView({ map, current, error, record, gate, loadNode, onOpenPage, onPause, onResume }) {
  const [selected, setSelected] = useState("");
  const [unfolded, setUnfolded] = useState(false);
  const editor = useRef(null);
  const built = useMemo(() => (map ? toGraph(map, current) : null), [map, current]);
  // The canvas is redrawn only when the shape of the map or a status changes; anything else updates the nodes in place, keeping the viewport.
  const shape = useMemo(() => (built ? JSON.stringify([built.graph.nodes.map(node => [node.id, node.type, node.meta.position, node.data.status, node.data.state]), built.graph.edges, [...built.roles]]) : ""), [built]);
  useEffect(() => {
    const document = editor.current?.document;
    if (!built || !document || document.disposed) return;
    for (const node of built.graph.nodes) document.getNode(node.id)?.updateExtInfo(node.data);
  }, [built]);
  useEffect(() => {
    const clear = (event) => { if (event.key === "Escape") setSelected(""); };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);
  if (!map) return <Empty title={error ? "The research map could not be read" : "Loading the research map"}>{error || "Reading the knowledge documents and the links between them from Molab."}</Empty>;
  if (built.graph.nodes.length === 0) return <Empty title="No research map yet">This workspace has no Plan, Roadmap, Finding or other research document. Write them in the conversation and they appear here, each pointing at the documents it refers to.</Empty>;
  // A selection can outlive its node when the map refreshes; treat it as cleared.
  const active = built.links.has(selected) ? selected : "";
  const related = active ? built.links.get(active) : null;
  const node = active ? map.nodes.find(entry => entry.id === active) : null;
  const context = { selected: active, select: setSelected, open: onOpenPage, isDim: id => related != null && !related.has(id) };
  const close = () => setSelected("");
  // Folded references stay hidden until asked for; selecting a document shows every reference it makes or receives and quiets the rest.
  const at = active ? built.index.get(active) : -1;
  const arrows = [
    unfolded ? "" : ".tw-view .tw-edge-folded{display:none}",
    active ? `.tw-view .tw-map-line{opacity:.14}.tw-view .tw-edge-a${at},.tw-view .tw-edge-b${at}{display:block;opacity:1}` : "",
  ].join("");
  return <CanvasContext.Provider value={context}>
    <style>{arrows}</style>
    <GraphCanvas key={shape} editor={editor} graph={built.graph} registries={registries} renderNode={MapNode} lineClass={line => `tw-map-line ${built.roles.get(`${line.from?.id}→${line.to?.id}`) ?? "tw-role-references"}`}
      tools={built.foldedCount > 0 && <button aria-pressed={unfolded} onClick={() => setUnfolded(value => !value)}>{unfolded ? "Fold references" : `All references +${built.foldedCount}`}</button>} />
    {!node && <NowCard map={map} record={record} gate={gate} onSelect={setSelected} onPause={onPause} onResume={onResume} />}
    {node && <DocumentPanel key={node.id} node={node} map={map} current={current !== null && node.host === current} load={loadNode} onOpen={setSelected} onOpenPage={() => onOpenPage(node.id)} onClose={close} />}
  </CanvasContext.Provider>;
}
