/**
 * A worker session bound to a delegation works inside the served root: its
 * file tools take paths inside the root, the temp directories or the
 * configured prefixes; its shell arguments may not name another workspace,
 * though its executable may live anywhere. The supervisor is not confined,
 * nor a worker of no delegation, and `workers.confine: false` turns it off.
 */
import { afterEach, describe, expect, it } from "@rstest/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../packages/research/src/config.js";
import { confinementVerdict, pathVerdict } from "../../packages/research/src/confine.js";
import { type Call, researchHarness, type ResearchHarness } from "../research-harness.js";

const ROOT = "/Users/roykid/lab/polymer";
const OTHER = "/Users/roykid/work/pbix-aem";
const HOME = "/Users/roykid";
const ALLOWED = ["/tmp", "/private/tmp", "/var/folders"];
const SYSTEM = ["/usr", "/opt", "/etc", "/dev", join(HOME, ".tack"), join(HOME, ".cache")];

describe("confinementVerdict", () => {
  const verdict = (command: string) => confinementVerdict(command, ROOT, ALLOWED, SYSTEM, HOME);

  it("refuses an argument path outside the root, whatever the command", () => {
    expect(verdict(`python ${OTHER}/scripts/build.py`)).toBe(`${OTHER}/scripts/build.py`);
    expect(verdict(`cat ${OTHER}/README.md`)).toBe(`${OTHER}/README.md`);
    expect(verdict(`ls ${OTHER}`)).toBe(OTHER);
    expect(verdict(`cd ${OTHER} && python build.py`)).toBe(OTHER);
    expect(verdict(`ls /`)).toBe("/");
    expect(verdict(`cp '${OTHER}/a.pdb' experiments/chain/scratch/`)).toBe(`${OTHER}/a.pdb`);
    expect(verdict(`python build.py --input=${OTHER}/unit.smi`)).toBe(`${OTHER}/unit.smi`);
    expect(verdict(`python build.py 2>${OTHER}/err.log`)).toBe(`${OTHER}/err.log`);
    expect(verdict(`PYTHONPATH=${OTHER}/src python build.py`)).toBe(`${OTHER}/src`);
    expect(verdict(`PATH=/usr/bin:${OTHER}/bin python build.py`)).toBe(`${OTHER}/bin`);
    expect(verdict(`ls ~/work/pbix-aem`)).toBe(OTHER);
    expect(verdict(`echo ok | tee ${OTHER}/log`)).toBe(`${OTHER}/log`);
  });

  it("lets the executable live anywhere, and arguments point at the root, the temp directories and the system", () => {
    for (const command of [
      `${OTHER}/.venv/bin/python build.py`,
      `/opt/homebrew/bin/python3 ${ROOT}/experiments/chain/build.py`,
      `exec ${OTHER}/.venv/bin/python -m molpy`,
      `env FOO=1 /usr/local/bin/uv run build.py`,
      `cat /etc/hosts`,
      `ls /tmp && ls ${tmpdir()}`,
      `python build.py > /dev/null 2>&1`,
      `cat ${HOME}/.tack/config.yml`,
      `curl http://localhost:8000/api/workspace/info`,
      `grep -rn bridge src/ experiments/chain`,
      `ls */scratch ../chain`,
      `echo '${ROOT}/experiments/chain/scratch/unit.smi'`,
      `python -c "print(1)"; ls`,
      "",
    ]) {
      expect(verdict(command), command).toBeUndefined();
    }
  });
});

describe("pathVerdict", () => {
  it("resolves relative paths against the root and names the resolved path when it is outside", () => {
    expect(pathVerdict("experiments/chain/scratch/unit.smi", ROOT, ALLOWED)).toBeUndefined();
    expect(pathVerdict(ROOT, ROOT, ALLOWED)).toBeUndefined();
    expect(pathVerdict(`${ROOT}/../polymer-old/x`, ROOT, ALLOWED)).toBe("/Users/roykid/lab/polymer-old/x");
    expect(pathVerdict("../../work/pbix-aem/x", ROOT, ALLOWED)).toBe(`${OTHER}/x`);
    expect(pathVerdict(`${ROOT}-copy/x`, ROOT, ALLOWED)).toBe(`${ROOT}-copy/x`);
    expect(pathVerdict("/tmp/x", ROOT, ALLOWED)).toBeUndefined();
    expect(pathVerdict("/tmp", ROOT, ALLOWED)).toBeUndefined();
  });
});

describe("worker confinement", () => {
  let h: ResearchHarness;
  afterEach(async () => {
    await h.close();
  });

  const child = (name: string, args: Record<string, unknown>, session = "child-1", parent = "S1"): Call => ({ name, arguments: args, agent: { session: { id: session, header: { origin: "subagent", parentSession: parent } } } });
  const supervisor = (name: string, args: Record<string, unknown>): Call => ({ name, arguments: args, agent: { session: { id: "S1" } } });
  const dispatch = (path: string) => h.call("research_dispatch", { delegation: path, worker: "spawn", description: "Build the trimer", task: "Build the trimer.", expected: ["trimer.pdb"] });

  it("confines a bound worker's file tools to the root and the temp directories, and names the root when refusing", async () => {
    h = await researchHarness(ROOT);
    const path = await h.open();
    await dispatch(path);
    for (const call of [
      child("read", { file_path: `${ROOT}/experiments/chain/scratch/unit.smi` }),
      child("read", { file_path: "experiments/chain/scratch/unit.smi" }),
      child("write", { file_path: join(tmpdir(), "scratch", "notes.txt"), content: "x" }),
      child("read_image", { file_path: "/tmp/plot.png" }),
      child("glob", { pattern: "**/*.pdb" }),
      child("grep", { pattern: "bridge", path: `${ROOT}/experiments` }),
      child("working_directory", {}),
      child("working_directory", { cd: "experiments/chain" }),
      child("bash", { command: "python experiments/chain/build.py", description: "Build" }),
      child("bash", { command: `${OTHER}/.venv/bin/python build.py`, description: "Build", workdir: `${ROOT}/experiments/chain` }),
    ]) {
      expect((await h.pre(call)).kind, `${call.name} ${JSON.stringify(call.arguments)}`).toBe("allow");
    }
    for (const call of [
      child("read", { file_path: `${OTHER}/src/model.py` }),
      child("read", { file_path: "../../work/pbix-aem/src/model.py" }),
      child("edit", { file_path: `${OTHER}/src/model.py`, old_string: "a", new_string: "b" }),
      child("glob", { pattern: "*.py", path: OTHER }),
      child("grep", { pattern: "x", path: OTHER }),
      child("working_directory", { cd: OTHER }),
      child("bash", { command: `python ${OTHER}/scripts/build.py`, description: "Build" }),
      child("bash", { command: `cat ${OTHER}/README.md`, description: "Read" }),
      child("bash", { command: `ls ${OTHER}`, description: "List" }),
      child("bash", { command: "ls", description: "List", workdir: OTHER }),
    ]) {
      const decision = await h.pre(call);
      expect(decision.kind, `${call.name} ${JSON.stringify(call.arguments)}`).toBe("deny");
      if (decision.kind !== "deny") continue;
      expect(decision.info).toEqual({ name: "TackWorkerConfined", code: "TACK_WORKER_CONFINED" });
      expect(decision.reason).toContain(`${call.name} reaches ${OTHER}`);
      expect(decision.reason).toContain(`work inside ${ROOT}; results from other workspaces must be given to you in the brief`);
    }
  });

  it("leaves the supervisor and a worker of no delegation alone, and adds the configured prefixes", async () => {
    h = await researchHarness(ROOT, { config: { workers: { allowedPaths: ["/Users/roykid/datasets"] } } });
    const path = await h.open();
    await dispatch(path);
    expect((await h.pre(supervisor("read", { file_path: `${OTHER}/src/model.py` }))).kind).toBe("allow");
    expect((await h.pre(supervisor("bash", { command: `ls ${OTHER}`, description: "List" }))).kind).toBe("allow");
    // A worker started elsewhere, by a session that works on no delegation.
    expect((await h.pre(child("read", { file_path: `${OTHER}/src/model.py` }, "child-free", "S9"))).kind).toBe("allow");
    // A child of the supervisor that has not been bound itself (its start is still being recorded) is confined through its parent.
    expect((await h.pre(child("read", { file_path: `${OTHER}/src/model.py` }, "child-new"))).kind).toBe("deny");
    expect((await h.pre(child("read", { file_path: "/Users/roykid/datasets/units.csv" }))).kind).toBe("allow");
    expect((await h.pre(child("bash", { command: "cat /Users/roykid/datasets/units.csv", description: "Read" }))).kind).toBe("allow");
    expect((await h.pre(child("read", { file_path: `${OTHER}/src/model.py` }))).kind).toBe("deny");
  });

  it("is off with workers.confine: false, and the config defaults to on", async () => {
    h = await researchHarness(ROOT, { config: { workers: { confine: false } } });
    const path = await h.open();
    await dispatch(path);
    expect((await h.pre(child("read", { file_path: `${OTHER}/src/model.py` }))).kind).toBe("allow");
    expect((await h.pre(child("bash", { command: `ls ${OTHER}`, description: "List" }))).kind).toBe("allow");
    expect((await h.pre(child("research_decide", {}))).kind).toBe("deny");
    expect(parseConfig({}).workers).toEqual({ confine: true, allowedPaths: [] });
    expect(() => parseConfig({ workers: { confine: "yes" } })).toThrow(/invalid config/);
  });
});
