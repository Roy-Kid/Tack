import { describe, expect, it } from "@rstest/core";
import { formatVersion } from "../../packages/tack/src/commands.js";
import { doctorExitCode, formatDoctorReport, onPath, type DoctorReport } from "../../packages/tack/src/doctor.js";

const base: DoctorReport = {
  tack: "0.1.0",
  runtime: { name: "DSH", version: "9.9.9" },
  node: "v22.0.0",
  home: "/x/tack",
  homeExists: true,
  profiles: [{ name: "default", dir: "/x/tack/profiles/default", bundles: ["a", "b"], layers: ["a", "b"], skipped: [] }],
  apiKeySet: false,
  pnpm: false,
  compose: { profile: "default", rows: 3, missing: [] },
};

describe("formatVersion", () => {
  it("prints exactly three labelled lines", () => {
    const text = formatVersion({ tack: "0.1.0", runtimeName: "DSH", runtimeVersion: "9.9.9", patches: 0 });
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Tack\s+0\.1\.0$/);
    expect(lines[1]).toMatch(/^Runtime\s+DSH 9\.9\.9$/);
    expect(lines[2]).toMatch(/^Patches\s+0$/);
  });
});

describe("formatDoctorReport", () => {
  it("mentions every field and never a secret", () => {
    const text = formatDoctorReport(base);
    expect(text).toContain("0.1.0");
    expect(text).toContain("DSH 9.9.9");
    expect(text).toContain("v22.0.0");
    expect(text).toContain("/x/tack");
    expect(text).toContain("DEEPSEEK_API_KEY: not set");
    expect(text).toContain("pnpm not found");
    expect(text).toContain("default: a, b");
    expect(text).toContain("3 rows");
    expect(text).not.toMatch(/sk-|secret/i);
  });

  it("reports set keys without their value and lists skipped bundles", () => {
    const text = formatDoctorReport({
      ...base,
      apiKeySet: true,
      profiles: [{ ...base.profiles[0]!, skipped: [{ packageName: "c", reason: "unreadable" }] }],
    });
    expect(text).toContain("DEEPSEEK_API_KEY: set");
    expect(text).toContain("skipped c: unreadable");
  });
});

describe("doctorExitCode", () => {
  it("is 0 for a healthy report", () => {
    expect(doctorExitCode(base)).toBe(0);
  });
  it("is 1 when required rows are missing, on error, or without a compose result", () => {
    expect(doctorExitCode({ ...base, compose: { profile: "default", rows: 1, missing: ["agent-loop"] } })).toBe(1);
    expect(doctorExitCode({ ...base, error: "boom" })).toBe(1);
    expect(doctorExitCode({ ...base, compose: undefined })).toBe(1);
  });
});

describe("onPath", () => {
  it("finds node on the current PATH and not a made-up binary", () => {
    expect(onPath("node")).toBe(true);
    expect(onPath("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
