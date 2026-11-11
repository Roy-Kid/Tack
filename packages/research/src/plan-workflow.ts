/** Serializable Plan graph shared by research_plan and its conversation workbench. */
import { z } from "zod";

interface GraphNode {
  id: string;
  type: string;
  meta?: { position: { x: number; y: number } };
  data: Record<string, unknown>;
  blocks?: GraphNode[];
  edges?: GraphEdge[];
}
interface GraphEdge { sourceNodeID: string; targetNodeID: string; sourcePortID?: string; targetPortID?: string }
const Edge = z.object({ sourceNodeID: z.string().min(1), targetNodeID: z.string().min(1), sourcePortID: z.string().optional(), targetPortID: z.string().optional() });
const Node: z.ZodType<GraphNode> = z.lazy(() => z.object({
  id: z.string().min(1), type: z.enum(["input", "agent", "tool", "parallel", "condition", "review", "output", "loop", "continue", "exit"]),
  meta: z.object({ position: z.object({ x: z.number().finite(), y: z.number().finite() }) }).optional(),
  data: z.looseObject({ title: z.string().min(1), summary: z.string().optional(), constraints: z.string().optional(), status: z.string().optional(), tone: z.enum(["blue", "green", "amber", "red", "violet", "muted"]).optional(), details: z.array(z.tuple([z.string(), z.string()])).optional(), branches: z.object({ primary: z.string(), secondary: z.string() }).optional() }), blocks: z.array(Node).max(200).optional(), edges: z.array(Edge).max(1000).optional(),
}));
export const PlanWorkflow = z.object({ nodes: z.array(Node).max(200), edges: z.array(Edge).max(1000) }).superRefine((graph, ctx) => {
  const ids = new Set<string>();
  const visit = (nodes: GraphNode[], edges: GraphEdge[], depth: number) => {
    if (depth > 8) { ctx.addIssue({ code: "custom", message: "Workflow nesting exceeds eight levels." }); return; }
    const local = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: `Duplicate node id: ${node.id}` });
      ids.add(node.id);
      if (ids.size > 200) { ctx.addIssue({ code: "custom", message: "Workflow exceeds 200 nodes." }); return; }
      if (node.blocks) visit(node.blocks, node.edges ?? [], depth + 1);
    }
    for (const edge of edges) if (!local.has(edge.sourceNodeID) || !local.has(edge.targetNodeID)) ctx.addIssue({ code: "custom", message: "A connection refers to a missing node." });
  };
  visit(graph.nodes, graph.edges, 0);
});

export type PlanWorkflowJSON = z.infer<typeof PlanWorkflow>;
