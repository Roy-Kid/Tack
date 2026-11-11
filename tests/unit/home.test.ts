import { describe, expect, it } from "@rstest/core";
import { join } from "node:path";
import { resolveTackHome } from "../../packages/tack/src/home.js";
import { bindHome } from "../../packages/tack/src/runtime/dsh.js";

describe("resolveTackHome", () => {
  it("uses TACK_HOME when set", () => {
    expect(resolveTackHome({ TACK_HOME: "/x/tack" }, "/home/u")).toBe("/x/tack");
  });

  it("expands ~ in TACK_HOME", () => {
    expect(resolveTackHome({ TACK_HOME: "~/mytack" }, "/home/u")).toBe(join("/home/u", "mytack"));
  });

  it("falls back to ~/.tack when unset or blank", () => {
    expect(resolveTackHome({}, "/home/u")).toBe(join("/home/u", ".tack"));
    expect(resolveTackHome({ TACK_HOME: "   " }, "/home/u")).toBe(join("/home/u", ".tack"));
  });
});

describe("bindHome", () => {
  it("binds the runtime home to the Tack home", () => {
    const env: NodeJS.ProcessEnv = {};
    const warnings: string[] = [];
    bindHome("/x/tack", env, (line) => warnings.push(line));
    expect(env.DSH_HOME).toBe("/x/tack");
    expect(warnings).toEqual([]);
  });

  it("overrides a different pre-set runtime home and warns once", () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: "/elsewhere" };
    const warnings: string[] = [];
    bindHome("/x/tack", env, (line) => warnings.push(line));
    expect(env.DSH_HOME).toBe("/x/tack");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/elsewhere");
    expect(warnings[0]).toContain("/x/tack");
  });
});
