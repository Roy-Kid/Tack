/**
 * Subagent providers behind DSH's subagent tool: Claude Code is DSH's
 * published plugin (`subagent_claude_code`); Codex is Tack's `@tack/codex`
 * over the app-server protocol (`subagent_codex`). Each package's own
 * `cordis.patch.yml` is loaded. The supervise profile keeps those tools and
 * turns off the supervisor's own command and edit tools.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { rmSync } from "node:fs";
import { parseDumpRows, spawnTack, tempHome, type DumpRow } from "../helpers.js";

const PLUGINS = [
  {
    providerId: "subagent-claude-code",
    provider: "@deepseek-ai/dsh-subagent-claude-code",
    toolId: "tool-subagent-claude-code",
    providerName: "claude-code",
    toolName: "subagent_claude_code",
  },
  {
    providerId: "subagent-codex",
    provider: "@tack/codex",
    toolId: "tool-subagent-codex",
    providerName: "codex",
    toolName: "subagent_codex",
  },
] as const;

let home: string;
const dumps = new Map<string, DumpRow[]>();

beforeAll(async () => {
  home = tempHome();
  for (const profile of ["default", "supervise"]) {
    const result = await spawnTack(["doctor", "--dump-config", "--profile", profile], { home });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe("");
    dumps.set(profile, parseDumpRows(result.stdout));
  }
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function row(profile: string, id: string): DumpRow {
  const found = dumps.get(profile)!.find((candidate) => candidate.id === id);
  expect(found, `${profile} is missing ${id}`).toBeDefined();
  return found!;
}

describe.each(["default", "supervise"])("profile %s", (profile) => {
  it("loads each official plugin's provider and tool", () => {
    for (const plugin of PLUGINS) {
      expect(row(profile, plugin.providerId).name).toBe(plugin.provider);
      const tool = row(profile, plugin.toolId);
      expect(tool.name).toBe("@deepseek-ai/dsh-tool-subagent");
      expect(tool.disabled).toBeUndefined();
      const text = tool.lines.join("\n");
      expect(text).toContain(`provider: ${plugin.providerName}`);
      expect(text).toContain(`toolName: ${plugin.toolName}`);
      expect(text).toContain("maxDepth: provider-managed");
    }
  });
});

describe("supervise profile", () => {
  it("does not let the supervisor edit or run commands", () => {
    for (const id of ["tool-bash", "tool-pwsh", "tool-subagent", "tool-subagent-fork"]) {
      expect(row("supervise", id).disabled).toBe("true");
    }
  });

  it("registers the official tools and keeps the supervisor from running commands", async () => {
    const mask = row("supervise", "tack-tool-mask");
    expect(mask.name).toBe("@tack/plugins/tool-mask");
    expect(mask.lines.join("\n")).toContain("deny:");
    expect(mask.lines.join("\n")).toMatch(/write/);
    expect(mask.lines.join("\n")).toMatch(/edit/);
    const result = await spawnTack(["doctor", "--profile", "supervise", "--tools"], { home });
    expect(result.code, result.stderr).toBe(0);
    const tools = result.stdout.split("\n");
    expect(tools).toContain("subagent_claude_code");
    expect(tools).toContain("subagent_codex");
    expect(tools).toContain("read");
    // `write` and `edit` stay registered because they share a row with `read`.
    // The tool mask above hides them from the supervisor.
    for (const hidden of ["bash", "delegate", "subagent"]) expect(tools).not.toContain(hidden);
  });
});
