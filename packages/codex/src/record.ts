/**
 * Where a Codex run's record goes. Tack's home holds configuration only, so a
 * record follows the work:
 *
 * 1. a configured directory, when the row names one;
 * 2. else the molab workspace the run's directory belongs to, under its
 *    machine-state directory: `<workspace>/.molab/agents/codex/`;
 * 3. else nowhere of Tack's: the thread is persisted by Codex itself, in
 *    Codex's own session store (`$CODEX_HOME/sessions`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where one run is recorded. */
export type RecordTarget = { kind: "directory"; dir: string } | { kind: "codex" };

/** The molab machine-state directory and the subdirectory for Codex records. */
const MOLAB_AGENT_DIR = [".molab", "agents", "codex"] as const;

/** Whether `dir/index.md` is a molab workspace root (`type: workspace.root` in its frontmatter). */
function isWorkspaceRoot(dir: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(dir, "index.md"), "utf8");
  } catch {
    return false;
  }
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return head !== null && /^type:\s*['"]?workspace\.root['"]?\s*$/m.test(head[1]!);
}

/** The nearest ancestor-or-self of `path` that is a molab workspace root, as molab decides it. */
export function enclosingMolabWorkspace(path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    if (isWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Decide where a run started in `cwd` is recorded. */
export function recordTarget(cwd: string, configured: string | undefined): RecordTarget {
  if (configured !== undefined) return { kind: "directory", dir: configured };
  const workspace = enclosingMolabWorkspace(cwd);
  return workspace === undefined ? { kind: "codex" } : { kind: "directory", dir: join(workspace, ...MOLAB_AGENT_DIR) };
}
