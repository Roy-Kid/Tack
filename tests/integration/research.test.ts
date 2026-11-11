/**
 * The research profile composes cleanly over the web app: the tack-research
 * row, the Research preset as the default, DSH's own subagent providers left
 * on (research_dispatch starts workers through them), and host-plane boots
 * (`doctor`, `model`) leave the research rows off, as they do for every app
 * composition — so `doctor --tools` lists no research tool; the tool list is
 * checked in the unit suite (research-model).
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { rmSync } from "node:fs";
import { parseDumpRows, spawnTack, tempHome, type DumpRow } from "../helpers.js";

let home: string;
let rows: DumpRow[];
let dumpStderr: string;

beforeAll(async () => {
  home = tempHome();
  const result = await spawnTack(["doctor", "--dump-config", "--profile", "research"], { home });
  expect(result.code, result.stderr).toBe(0);
  rows = parseDumpRows(result.stdout);
  dumpStderr = result.stderr;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function row(id: string): DumpRow {
  const found = rows.find((candidate) => candidate.id === id);
  expect(found, `research is missing ${id}`).toBeDefined();
  return found!;
}

describe("research profile", () => {
  it("composes without warnings", () => {
    expect(dumpStderr.trim()).toBe("");
  });

  it("mounts tack-research and makes Research the default preset", () => {
    expect(row("tack-research").name).toBe("@tack/research");
    expect(row("tack-molplot").name).toBe("@tack/molplot");
    expect(row("tack-molvis").name).toBe("@tack/molvis");
    expect(row("preset-research").lines.join("\n")).toContain("id: research");
    expect(row("agent-preset-registry").lines.join("\n")).toContain("default: research");
  });

  it("leaves the subagent tools on, Codex through @tack/codex", () => {
    for (const id of ["subagent-claude-code", "subagent-codex", "tool-subagent-claude-code", "tool-subagent-codex"]) {
      expect(row(id).disabled, id).toBeUndefined();
    }
    expect(row("subagent-codex").name).toBe("@tack/codex");
  });

  it("the Research preset executes with DSH's shell and file tools", () => {
    const preset = row("preset-research").lines.join("\n");
    for (const tool of ["dsh-tool-bash", "'@deepseek-ai/dsh-tool-fs'"]) expect(preset).toContain(tool);
  });

  it("boots the host plane without activating research rows or warnings", async () => {
    const result = await spawnTack(["doctor", "--profile", "research", "--tools"], { home });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("did not activate");
  });
});

describe("research-run profile", () => {
  it("adds the research tools and persona on the headless stack and nothing else", async () => {
    const result = await spawnTack(["doctor", "--dump-config", "--profile", "research-run"], { home });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const dump = parseDumpRows(result.stdout);
    const find = (id: string) => dump.find((candidate) => candidate.id === id);
    expect(find("tack-research")?.name).toBe("@tack/research");
    expect(find("tack-research-tool-mask")).toBeUndefined();
    for (const id of ["tool-subagent-codex", "tool-subagent-claude-code", "subagent-spawn-in-process"]) expect(find(id)?.disabled, id).toBeUndefined();
  });
});

describe("research persona", () => {
  it("is the same text in the web preset and the headless profile, and steers workers through research_dispatch", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { REPO_ROOT } = await import("../helpers.js");
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    const web = readFileSync(join(REPO_ROOT, "bundles/research/cordis.patch.yml"), "utf8").match(/prefix: >-\n([\s\S]*?)\n\s+suffix:/)![1]!;
    const run = readFileSync(join(REPO_ROOT, "bundles/research-run/cordis.patch.yml"), "utf8").match(/personaPrefix: >-\n([\s\S]*)$/)![1]!;
    expect(flat(run)).toBe(flat(web));
    const persona = flat(web);
    expect(persona).toContain("ask_human");
    expect(persona).toContain("research_dispatch");
    expect(persona).toContain("do not probe the workspace before dispatching");
    expect(persona).toContain("research_assess with report");
    expect(persona).toContain("Closing (conclude or stop) is the last call");
    // The four human gates, in order, and the rule behind them.
    for (const gate of ["Gate 1, parameters", "Gate 2, plan", "Gate 3, dry run", "Gate 4, results"]) expect(persona).toContain(gate);
    expect(persona.indexOf("Gate 1, parameters")).toBeLessThan(persona.indexOf("Gate 2, plan"));
    expect(persona.indexOf("Gate 2, plan")).toBeLessThan(persona.indexOf("Gate 3, dry run"));
    expect(persona.indexOf("Gate 3, dry run")).toBeLessThan(persona.indexOf("Gate 4, results"));
    expect(persona).toContain("never fabricate an approval");
    expect(persona).toContain("research_dispatch with mode draft");
    expect(persona).toContain("research_resume with their words, passing approve {gate: plan, target: <plan path>} only when they clearly approved that path");
    expect(persona).toContain("never guess a parameter");
    expect(persona).toContain("revising the same plan (research_plan, same name, with a reason)");
    expect(persona).toContain("citing at least one molab: ref, under a stable name");
    expect(persona).toContain("never link them from a report");
    expect(persona).not.toContain("HTML page");
    expect(persona).not.toContain("decision Observations");
    expect(persona).not.toContain("execute the plan yourself");
    expect(persona).not.toContain("subagent_codex");
  });
});
