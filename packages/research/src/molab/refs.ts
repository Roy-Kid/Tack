/**
 * `molab:` references. Molab's identity scheme: refs name entities by id, never
 * by path. A run ref names its experiment, not its project.
 */
const SCHEME = "molab:";

export const projectRef = (project: string): string => `${SCHEME}project/${project}`;
export const experimentRef = (experiment: string): string => `${SCHEME}experiment/${experiment}`;
export const runRef = (experiment: string, run: string): string => `${experimentRef(experiment)}/run/${run}`;
export const executionRef = (experiment: string, run: string, execution: string): string => `${runRef(experiment, run)}/execution/${execution}`;

const ASSET_REF = /^molab:asset\/[^/\s]+$/;

/** Whether `ref` names a registered asset (`molab:asset/<id>`): a product a document can cite and molab's viewers can open. */
export const isAssetRef = (ref: string): boolean => ASSET_REF.test(ref);

export interface ParsedRef {
  project?: string;
  experiment?: string;
  run?: string;
  execution?: string;
}

const PATTERNS: [RegExp, (match: RegExpMatchArray) => ParsedRef][] = [
  [/^molab:project\/([^/]+)$/, (m) => ({ project: m[1]! })],
  [/^molab:experiment\/([^/]+)$/, (m) => ({ experiment: m[1]! })],
  [/^molab:experiment\/([^/]+)\/run\/([^/]+)$/, (m) => ({ experiment: m[1]!, run: m[2]! })],
  [/^molab:experiment\/([^/]+)\/run\/([^/]+)\/execution\/([^/]+)$/, (m) => ({ experiment: m[1]!, run: m[2]!, execution: m[3]! })],
];

/** Parse a project / experiment / run / execution ref; throws on anything else. */
export function parseRef(ref: string): ParsedRef {
  for (const [pattern, build] of PATTERNS) {
    const match = ref.match(pattern);
    if (match !== null) return build(match);
  }
  throw new Error(
    `not a molab project, experiment, run or execution ref: ${ref}. ` +
      "Write it as molab:project/<project id>, molab:experiment/<experiment id>, " +
      "molab:experiment/<experiment id>/run/<run id> or …/run/<run id>/execution/<execution id>; " +
      "ids, not names or paths (research_context lists them).",
  );
}

/** The DocSource kind a scope ref is cited as. */
export function sourceKindOf(ref: string): "project" | "experiment" | "run" {
  const parsed = parseRef(ref);
  if (parsed.run !== undefined) return "run";
  if (parsed.experiment !== undefined) return "experiment";
  if (parsed.project !== undefined) return "project";
  throw new Error(`a source must be a project, experiment or run ref: ${ref}`);
}
