// Synthetic preview fixture. The production workbench never imports this module.
const node = (id, type, title, x, y, summary, status = "Waiting for upstream", tone = "muted", details = [], branches) => ({
  id, type, meta: { position: { x, y } }, data: { title, summary, status, tone, details, ...(branches && { branches }) },
});
const edge = (sourceNodeID, targetNodeID, sourcePortID, targetPortID) => ({ sourceNodeID, targetNodeID, ...(sourcePortID && { sourcePortID }), ...(targetPortID && { targetPortID }) });
export const examples = [{
  id: "scan", title: "Polymer candidate search", plan: 5, execution: "wf-027", selected: "n_eval",
  graph: {
    nodes: [
      node("input", "input", "Experiment input", 0, 178, "Fixed research question", "Ready", "green"),
      { ...node("iter_search", "loop", "Candidate search", 175, 20, "Search within approved bounds. Exit on the acceptance target or iteration limit.", "Iteration 2 of 3", "violet"),
        blocks: [
          node("n_generate", "agent", "Generate", 24, 112, "12 candidates · Fixed bounds", "Completed this iteration", "green", [["Candidates", "12"], ["Composition", "0.10–0.30"], ["Output", "candidates[]"]]),
          node("n_eval", "parallel", "Batch evaluation", 248, 112, "12 runs · Max 4 concurrent", "8 passed · 3 active · 1 retry", "blue", [["Candidate", "AABB / seed 03"], ["Composition", "0.24"], ["Executor", "Molab · local"], ["Retry policy", "Up to 2 identical attempts"]]),
          node("n_check", "condition", "Acceptance gate", 472, 105, "Target score ≥ 0.80", "Waiting for evaluation", "muted", [["Accepted", "Exit and summarize"], ["Below target", "Continue within bounds"]], { primary: "Target met / limit reached", secondary: "Below target" }),
          node("continue", "continue", "Continue next iteration", 248, 280, "Keep the approved bounds", "Waiting for decision", "violet"),
          node("loop_exit", "exit", "Search exit", 664, 147, "Target met / limit reached"),
        ],
        edges: [edge("n_generate", "n_eval"), edge("n_eval", "n_check"), edge("n_check", "continue", "secondary"), edge("n_check", "loop_exit", "primary")],
      },
      node("n_report", "output", "Summarize results", 960, 132, "Candidates, metrics and evidence", "Waiting for search"),
      node("n_review", "review", "Review findings", 960, 314, "Owner confirms the conclusion", "Waiting for summary"),
    ],
    edges: [edge("input", "iter_search"), edge("iter_search", "n_report"), edge("n_report", "n_review", "bottom", "top")],
  },
}];
