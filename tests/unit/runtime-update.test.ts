import { describe, expect, it } from "@rstest/core";
import { join } from "node:path";
import {
  currentRuntimeVersion,
  isUpdate,
  renderReport,
  runtimePins,
  withRuntimeVersion,
  type Manifest,
} from "../../scripts/runtime-update.ts";
import { REPO_ROOT, readJson } from "../helpers.js";

const manifest: Manifest = {
  name: "tack",
  dependencies: { "@deepseek-ai/dsh": "1.0.0-rc.1", "@deepseek-ai/dsh-base": "1.0.0-rc.1", commander: "15.0.0" },
};

describe("runtime pins", () => {
  it("selects only runtime packages", () => {
    expect(Object.keys(runtimePins(manifest))).toEqual(["@deepseek-ai/dsh", "@deepseek-ai/dsh-base"]);
  });

  it("reads the single pinned version", () => {
    expect(currentRuntimeVersion(manifest)).toBe("1.0.0-rc.1");
  });

  it("rejects disagreeing or inexact pins", () => {
    expect(() => currentRuntimeVersion({ dependencies: { "@deepseek-ai/dsh": "1.0.0", "@deepseek-ai/dsh-base": "1.0.1" } })).toThrow();
    expect(() => currentRuntimeVersion({ dependencies: { "@deepseek-ai/dsh": "^1.0.0" } })).toThrow();
    expect(() => currentRuntimeVersion({ dependencies: {} })).toThrow();
  });

  it("reads the real Tack manifest", () => {
    const tack = readJson<Manifest>(join(REPO_ROOT, "packages", "tack", "package.json"));
    expect(() => currentRuntimeVersion(tack)).not.toThrow();
  });
});

describe("isUpdate", () => {
  it("orders prereleases and releases", () => {
    expect(isUpdate("0.1.7-rc.2", "0.1.7-rc.3")).toBe(true);
    expect(isUpdate("0.1.7-rc.2", "0.1.7")).toBe(true);
    expect(isUpdate("0.1.7-rc.2", "0.1.8-alpha.1")).toBe(true);
    expect(isUpdate("0.1.7-rc.2", "0.1.7-rc.2")).toBe(false);
    expect(isUpdate("0.1.7-rc.2", "0.1.7-rc.1")).toBe(false);
  });
});

describe("withRuntimeVersion", () => {
  it("re-pins every runtime package and nothing else", () => {
    const next = withRuntimeVersion(manifest, "1.0.0");
    expect(next.dependencies).toEqual({ "@deepseek-ai/dsh": "1.0.0", "@deepseek-ai/dsh-base": "1.0.0", commander: "15.0.0" });
    expect(manifest.dependencies?.["@deepseek-ai/dsh"]).toBe("1.0.0-rc.1");
  });

  it("refuses a range", () => {
    expect(() => withRuntimeVersion(manifest, "^1.0.0")).toThrow();
  });
});

describe("renderReport", () => {
  it("states success and lists pins", () => {
    const body = renderReport({ from: "1.0.0-rc.1", to: "1.0.0", outcome: "success", pins: ["@deepseek-ai/dsh"] });
    expect(body).toContain("`1.0.0-rc.1`");
    expect(body).toContain("`1.0.0`");
    expect(body).toContain("pass");
    expect(body).toContain("- `@deepseek-ai/dsh`");
    expect(body).not.toContain("<details>");
  });

  it("flags failure and includes only the log tail", () => {
    const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const body = renderReport({ from: "a", to: "b", outcome: "failure", pins: [], log, logLines: 5 });
    expect(body).toContain("Verification failed");
    expect(body).toContain("line 199");
    expect(body).not.toContain("line 194\n");
  });
});
