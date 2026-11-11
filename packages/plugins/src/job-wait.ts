/**
 * Refuse shell `sleep` while the calling agent has background work running:
 * a subagent it started (Claude Code, Codex, an in-process worker) or a
 * background job it owns.
 *
 * The runtime tells the owner when that work settles: a subagent's completion
 * notice carries its final answer, and the host keeps a headless run alive
 * until the agent's children finish, so ending the turn is the way to wait.
 * `job_output` with `wait: true` blocks on a job. An agent that sleeps in the
 * shell instead burns turns polling and can outwait the work without noticing
 * it finished. The refusal names what is running and how to wait. `sleep` with
 * nothing running (waiting for a server to come up) is untouched.
 */
export const name = "tack-job-wait";
export const inject = ["tools", "jobs"];

/** A job's lifecycle state, as the runtime's job registry reports it. */
type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

interface JobView {
  readonly id: string;
  readonly label: string;
  readonly owner?: string;
  readonly status: JobStatus;
}

interface AgentLike {
  session: { id: unknown };
}

interface ToolExecution {
  name: string;
  arguments: unknown;
  agent?: AgentLike;
}

interface ToolResult {
  isError: boolean;
  value?: unknown;
}

interface JobWaitContext {
  jobs: { list(caller?: string): JobView[] };
  on(event: "tools/pre-execute", listener: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown>): () => void;
  on(
    event: "tools/post-execute",
    listener: (exec: ToolExecution, result: Readonly<ToolResult>, next: () => Promise<unknown>) => Promise<unknown>,
  ): () => void;
  on(event: "subagent/end", listener: (info: { id: unknown }) => void): () => void;
}

/** The shell tools whose commands are read. */
const SHELL_TOOLS = new Set(["bash"]);
const LIVE: ReadonlySet<JobStatus> = new Set(["running", "stopping"]);
const DENIED = { name: "TackJobWait", code: "TACK_JOB_WAIT" };

/** Whether any command in a shell line is `sleep` (after env assignments and `command`/`exec`). */
export function sleepsInShell(command: string): boolean {
  return command
    .split(/&&|\|\||[;|&\n]|\$\(|`/)
    .map((segment) => segment.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)))
    .some((words) => {
      const head = words[0] === "command" || words[0] === "exec" ? words[1] : words[0];
      return head === "sleep" || head?.endsWith("/sleep") === true;
    });
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** The child id of a subagent tool's result (`{ kind: "activation", subagentId }`). */
function startedSubagent(result: Readonly<ToolResult>): string | undefined {
  if (result.isError || typeof result.value !== "object" || result.value === null) return undefined;
  const value = result.value as { kind?: unknown; subagentId?: unknown };
  return value.kind === "activation" && typeof value.subagentId === "string" ? value.subagentId : undefined;
}

export function apply(ctx: JobWaitContext): void {
  /** Live subagents by the session that started them. */
  const children = new Map<string, Set<string>>();

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const child = startedSubagent(result);
    if (child !== undefined && exec.agent !== undefined) {
      const parent = String(exec.agent.session.id);
      children.set(parent, new Set([...(children.get(parent) ?? []), child]));
    }
    return next();
  });

  ctx.on("subagent/end", ({ id }) => {
    const child = String(id);
    for (const [parent, live] of children) {
      if (!live.has(child)) continue;
      const rest = new Set([...live].filter((other) => other !== child));
      if (rest.size === 0) children.delete(parent);
      else children.set(parent, rest);
    }
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.agent === undefined || !SHELL_TOOLS.has(exec.name)) return next();
    const command = commandOf(exec.arguments);
    if (command === undefined || !sleepsInShell(command)) return next();
    const session = String(exec.agent.session.id);
    const subagents = [...(children.get(session) ?? [])];
    const jobs = ctx.jobs.list(session).filter((job) => job.owner === session && LIVE.has(job.status));
    if (subagents.length === 0 && jobs.length === 0) return next();
    const running = [...subagents.map((id) => `subagent ${id}`), ...jobs.map((job) => `job ${job.id} (${job.label})`)].join(", ");
    return {
      kind: "deny",
      reason:
        `Not run: this command sleeps while your background work is running: ${running}. ` +
        "The runtime notifies you when it finishes, and a subagent's notice carries its final answer. " +
        "Keep working on independent steps, or end your turn and wait for the notice; " +
        "for a job you are blocked on, call job_output with its job_id and wait: true.",
      info: DENIED,
    };
  });
}
