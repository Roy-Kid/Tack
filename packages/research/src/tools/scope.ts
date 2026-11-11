/**
 * The bound scope: the node `molab serve` opened, as a `molab:` ref, and the
 * host directory a delegation document lands in.
 */
import type { MolabClient } from "../molab/client.js";
import { experimentRef, parseRef, projectRef, runRef } from "../molab/refs.js";

export interface BoundScope {
  kind: string;
  /** The served node's ref; `undefined` when molab serves a whole workspace. */
  ref?: string;
  name: string;
}

/** The served node as a ref. A run root is asked for its experiment, since run refs name it. */
export async function boundScope(molab: MolabClient, signal?: AbortSignal): Promise<BoundScope> {
  const scope = await molab.scope(signal);
  // molab spells kinds as record types: workspace.root / workspace.project / workspace.experiment / workspace.run.
  const kind = scope.kind.replace(/^workspace\./, "");
  switch (kind) {
    case "project":
      return { kind, ref: projectRef(scope.id), name: scope.name };
    case "experiment":
      return { kind, ref: experimentRef(scope.id), name: scope.name };
    case "run": {
      const run = await molab.getRun({ project: "-", experiment: "-", run: scope.id }, signal);
      return { kind, ref: runRef(run.experimentId, scope.id), name: scope.name };
    }
    default:
      return { kind, name: scope.name };
  }
}

/**
 * The workspace-relative directory of `ref`, where its delegation lives.
 * The served node itself is "" (the server's root). A descendant needs its
 * project id, because refs below a project omit it.
 */
export async function hostPathOf(molab: MolabClient, served: BoundScope, ref: string, project: string | undefined, signal?: AbortSignal): Promise<string> {
  if (served.ref === ref) return "";
  const parsed = parseRef(ref);
  if (parsed.project !== undefined) {
    const found = (await molab.listProjects(signal)).find((item) => item.id === parsed.project);
    if (found === undefined) throw new Error(`project ${parsed.project} is not visible from the served scope`);
    return found.path;
  }
  const projectId = project ?? (served.ref !== undefined ? parseRef(served.ref).project : undefined) ?? "-";
  if (parsed.run !== undefined) return (await molab.getRun({ project: projectId, experiment: parsed.experiment!, run: parsed.run }, signal)).path;
  const experiments = await molab.listExperiments(projectId, signal);
  const found = experiments.find((item) => item.id === parsed.experiment);
  if (found === undefined) throw new Error(`experiment ${parsed.experiment} is not visible under project ${projectId}`);
  return found.path;
}
