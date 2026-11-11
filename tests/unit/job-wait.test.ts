/**
 * Waiting on subagents: shell `sleep` is refused while the agent owns a running
 * background job, and left alone otherwise.
 */
import { describe, expect, it } from "@rstest/core";
import { apply, sleepsInShell } from "../../packages/plugins/src/job-wait.js";

type Listener = (...args: unknown[]) => Promise<unknown> | void;

function wire(jobs: { id: string; label: string; owner?: string; status: string }[]) {
  const listeners = new Map<string, Listener>();
  apply({
    jobs: { list: () => jobs as never },
    on: (event: string, fn: Listener) => (listeners.set(event, fn), () => {}),
  } as never);
  const allowed = Symbol("allowed");
  const agent = (session: string) => ({ session: { id: session } });
  const call = async (name: string, command: string, session = "s1") =>
    (listeners.get("tools/pre-execute")!({ name, arguments: { command }, agent: agent(session) }, async () => allowed) as Promise<unknown>).then(
      (decision) => (decision === allowed ? "allowed" : (decision as { reason: string }).reason),
    );
  const startSubagent = (child: string, session = "s1") =>
    listeners.get("tools/post-execute")!(
      { name: "subagent_claude_code", arguments: {}, agent: agent(session) },
      { isError: false, value: { kind: "activation", subagentId: child } },
      async () => ({ kind: "accept" }),
    );
  const endSubagent = (child: string) => listeners.get("subagent/end")!({ id: child });
  return { call, startSubagent, endSubagent };
}

const harness = (jobs: Parameters<typeof wire>[0]) => wire(jobs).call;

describe("sleepsInShell", () => {
  it("finds sleep as a command anywhere in the line", () => {
    for (const line of ["sleep 30", "sleep 5 && ls", "ls; sleep 1", "X=1 sleep 2", "command sleep 3", "/bin/sleep 4", "echo $(sleep 1)"]) {
      expect(sleepsInShell(line)).toBe(true);
    }
  });

  it("does not mistake an argument or a longer name for sleep", () => {
    for (const line of ["ls sleep", "grep -n sleep file", "sleepwalk", "echo 'no'"]) {
      expect(sleepsInShell(line)).toBe(false);
    }
  });
});

describe("job wait", () => {
  it("refuses sleep while the agent's own job runs, naming it and how to wait", async () => {
    const call = harness([{ id: "subagent-1", label: "Claude Code: build", owner: "s1", status: "running" }]);
    const reason = await call("bash", "sleep 60");
    expect(reason).toContain("subagent-1");
    expect(reason).toContain("job_output");
  });

  it("refuses sleep while a subagent the agent started is live, and allows it once it ends", async () => {
    const { call, startSubagent, endSubagent } = wire([]);
    await startSubagent("child-7");
    const reason = await call("bash", "sleep 45; cat hello.txt");
    expect(reason).toContain("subagent child-7");
    expect(reason).toContain("end your turn");
    expect(await call("bash", "sleep 1", "s2")).toBe("allowed");
    endSubagent("child-7");
    expect(await call("bash", "sleep 1")).toBe("allowed");
  });

  it("allows sleep when no job runs, when only another session's job runs, and other tools", async () => {
    expect(await harness([])("bash", "sleep 2")).toBe("allowed");
    expect(await harness([{ id: "j", label: "x", owner: "s2", status: "running" }])("bash", "sleep 2")).toBe("allowed");
    expect(await harness([{ id: "j", label: "x", owner: "s1", status: "completed" }])("bash", "sleep 2")).toBe("allowed");
    expect(await harness([{ id: "j", label: "x", owner: "s1", status: "running" }])("bash", "ls")).toBe("allowed");
    expect(await harness([{ id: "j", label: "x", owner: "s1", status: "running" }])("read", "sleep 1")).toBe("allowed");
  });
});
