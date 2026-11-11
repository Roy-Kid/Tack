import React, { createContext, useMemo } from "react";
import { EditorRenderer, FreeLayoutEditorProvider, usePlaygroundTools } from "@flowgram.ai/free-layout-editor";
import "@flowgram.ai/free-layout-editor/index.css";

/** What a node renderer needs from the view that owns the canvas. */
export const CanvasContext = createContext({ selected: "", select: () => {}, open: () => {}, isDim: () => false });

const LINE_COLORS = { default: "#b3b5ae", selected: "#1f4fd8", hovered: "#1f4fd8", drawing: "#1f4fd8", flowing: "#1f4fd8", error: "#b3372f", hidden: "transparent" };
const LINE_WIDTH = 1.75;

function ZoomPill({ children }) {
  const tools = usePlaygroundTools();
  return <div className="tw-pill tw-zoom">
    <button aria-label="Zoom out" onClick={() => tools.zoomout()}>−</button>
    <span>{Math.round(tools.zoom * 100)}%</span>
    <button aria-label="Zoom in" onClick={() => tools.zoomin()}>+</button>
    <button onClick={() => tools.fitView()}>Fit</button>
    {children}
  </div>;
}

/**
 * A read-only FlowGram canvas for the research map.
 * `graph` is read once per mount: remount with a new `key` to redraw.
 */
export function GraphCanvas({ graph, registries, renderNode, editor, lineClass, tools }) {
  const props = useMemo(() => ({
    initialData: structuredClone(graph), nodeRegistries: registries, readonly: true, background: false,
    nodeEngine: { enable: false }, variableEngine: { enable: false },
    materials: { renderDefaultNode: renderNode },
    lineColor: LINE_COLORS,
    isHideArrowLine: () => false,
    setLineClassName: (_ctx, line) => lineClass?.(line),
    onInit: (ctx) => { if (editor) editor.current = ctx; },
    onAllLayersRendered: (ctx) => {
      if (editor) editor.current = ctx;
      if (ctx.document.disposed) return;
      ctx.document.getAllEdges().forEach(line => line.updateUIState({ shrink: 0, strokeWidth: LINE_WIDTH }));
      ctx.tools.fitView(false);
    },
    onDispose: (ctx) => { if (editor?.current === ctx) editor.current = null; },
  }), []);
  return <FreeLayoutEditorProvider {...props}><EditorRenderer className="tw-editor" /><ZoomPill>{tools}</ZoomPill></FreeLayoutEditorProvider>;
}
