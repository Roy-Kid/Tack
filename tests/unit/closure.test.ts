import { describe, expect, it } from "@rstest/core";
import { classify, diffClosure, groupOf, lockedClosure, readClosureFile, type ClosureFile } from "../../scripts/runtime-closure.ts";

describe("runtime closure classification", () => {
  it("reads the source group from the repository directory", () => {
    expect(groupOf("packages/session/session-log-deepseek", "@deepseek-ai/dsh-session-log-deepseek")).toBe("session");
    expect(groupOf("vendor/cordis", "@deepseek-ai/cordis")).toBe("vendor");
    expect(groupOf(undefined, "@deepseek-ai/node-addon-system-darwin-x64")).toBe("native");
  });

  it("uses runtime core and UI components as they are", () => {
    expect(classify("@deepseek-ai/dsh-agent-loop", "core")).toEqual({ group: "core", class: "engine", decision: "use" });
    expect(classify("@deepseek-ai/dsh-client-ui-chat", "client")).toMatchObject({ class: "ui-component", decision: "use" });
    expect(classify("@deepseek-ai/dsh-client-connection", "client")).toMatchObject({ class: "browser-infra", decision: "use" });
  });

  it("wraps chrome, disables DeepSeek policy, forbids experimental", () => {
    expect(classify("@deepseek-ai/dsh-client-ui-layout", "client")).toMatchObject({ class: "chrome", decision: "wrap" });
    expect(classify("@deepseek-ai/dsh-session-telemetry-otel", "session")).toMatchObject({ class: "deepseek-policy", decision: "disable" });
    expect(classify("@deepseek-ai/dsh-experimental-agent-team", "experimental")).toMatchObject({ decision: "forbidden" });
  });

  it("refuses a package from a group it has no rule for", () => {
    expect(() => classify("@deepseek-ai/dsh-brand-new", "brand-new-group")).toThrow(/no review rule/);
  });
});

describe("diffClosure", () => {
  const reviewed: ClosureFile = {
    runtime: "1.0.0",
    packages: {
      "@deepseek-ai/a": { group: "core", class: "engine", decision: "use" },
      "@deepseek-ai/x": { group: "experimental", class: "experimental", decision: "forbidden" },
      "@deepseek-ai/gone": { group: "core", class: "engine", decision: "use" },
    },
  };

  it("reports unreviewed, stale, and forbidden packages", () => {
    expect(diffClosure(["@deepseek-ai/a", "@deepseek-ai/new", "@deepseek-ai/x"], reviewed)).toEqual({
      unreviewed: ["@deepseek-ai/new"],
      stale: ["@deepseek-ai/gone"],
      forbidden: ["@deepseek-ai/x"],
    });
  });
});

describe("Tack's installed runtime closure", () => {
  it("is fully reviewed, has no stale entries, and contains nothing forbidden", () => {
    expect(diffClosure(lockedClosure(), readClosureFile())).toEqual({ unreviewed: [], stale: [], forbidden: [] });
  });

  it("does not include the runtime's own launcher or experimental packages", () => {
    const installed = lockedClosure();
    expect(installed).not.toContain("@deepseek-ai/dsh");
    expect(installed.filter((name) => name.includes("experimental"))).toEqual([]);
  });
});
