import { describe, expect, it } from "@rstest/core";
import { CommanderError } from "commander";
import { DEFAULT_RUN_PROFILE, DEFAULT_WEB_PROFILE, helpText, parseTackArgs } from "../../packages/tack/src/cli.js";

describe("parseTackArgs", () => {
  it("resolves bare invocation to help", () => {
    expect(parseTackArgs([])).toEqual({ mode: "help" });
  });

  it("resolves version in both spellings", () => {
    expect(parseTackArgs(["-V"])).toEqual({ mode: "version" });
    expect(parseTackArgs(["--version"])).toEqual({ mode: "version" });
    expect(parseTackArgs(["version"])).toEqual({ mode: "version" });
  });

  it("parses run with Tack flags first and forwards the rest verbatim", () => {
    expect(parseTackArgs(["run", "--profile", "x", "--patch", "a.yml", "--patch", "b.yml", "--json", "hi", "-"])).toEqual({
      mode: "run",
      profile: "x",
      patches: ["a.yml", "b.yml"],
      args: ["--json", "hi", "-"],
    });
  });

  it("defaults the run profile and forwards --help to the app", () => {
    expect(parseTackArgs(["run", "--help"])).toEqual({ mode: "run", profile: DEFAULT_RUN_PROFILE, patches: [], args: ["--help"] });
    expect(parseTackArgs(["run", "-h"])).toEqual({ mode: "run", profile: DEFAULT_RUN_PROFILE, patches: [], args: ["-h"] });
  });

  it("stops parsing Tack flags at the first app token", () => {
    // `--profile` after an app token belongs to the app, not Tack.
    expect(parseTackArgs(["run", "hello", "--profile", "x"])).toEqual({
      mode: "run",
      profile: DEFAULT_RUN_PROFILE,
      patches: [],
      args: ["hello", "--profile", "x"],
    });
  });

  it("parses web and keeps app flags in order", () => {
    expect(parseTackArgs(["web", "--port", "0", "--no-open", "--trusted-host", "a", "b"])).toEqual({
      mode: "web",
      profile: DEFAULT_WEB_PROFILE,
      patches: [],
      args: ["--port", "0", "--no-open", "--trusted-host", "a", "b"],
    });
  });

  it("parses doctor options", () => {
    expect(parseTackArgs(["doctor"])).toEqual({ mode: "doctor", profile: DEFAULT_RUN_PROFILE, dumpConfig: false, tools: false });
    expect(parseTackArgs(["doctor", "--dump-config", "--profile", "web"])).toEqual({ mode: "doctor", profile: "web", dumpConfig: true, tools: false });
  });

  it("rejects an unknown command and a repeated profile", () => {
    expect(() => parseTackArgs(["frobnicate"])).toThrow(CommanderError);
    expect(() => parseTackArgs(["run", "--profile", "a", "--profile", "b"])).toThrow(CommanderError);
  });

  it("describes every command in Tack's own help", () => {
    const help = helpText();
    expect(help).toContain("Usage: tack");
    for (const command of ["run", "web", "doctor", "version"]) expect(help).toContain(command);
  });
});

describe("parseTackArgs plugin", () => {
  it("parses each plugin action with the default profile", () => {
    expect(parseTackArgs(["plugin", "add", "a", "./b.tgz"])).toEqual({ mode: "plugin", action: "add", profile: DEFAULT_RUN_PROFILE, names: ["a", "./b.tgz"] });
    expect(parseTackArgs(["plugin", "remove", "a"])).toEqual({ mode: "plugin", action: "remove", profile: DEFAULT_RUN_PROFILE, names: ["a"] });
    expect(parseTackArgs(["plugin", "enable", "a"])).toEqual({ mode: "plugin", action: "enable", profile: DEFAULT_RUN_PROFILE, names: ["a"] });
    expect(parseTackArgs(["plugin", "disable", "a"])).toEqual({ mode: "plugin", action: "disable", profile: DEFAULT_RUN_PROFILE, names: ["a"] });
    expect(parseTackArgs(["plugin", "list"])).toEqual({ mode: "plugin", action: "list", profile: DEFAULT_RUN_PROFILE, names: [] });
  });

  it("targets another profile", () => {
    expect(parseTackArgs(["plugin", "add", "a", "--profile", "web"])).toEqual({ mode: "plugin", action: "add", profile: "web", names: ["a"] });
    expect(parseTackArgs(["plugin", "list", "--profile", "web"])).toEqual({ mode: "plugin", action: "list", profile: "web", names: [] });
  });

  it("requires a package for add, remove, enable, and disable", () => {
    for (const action of ["add", "remove", "enable", "disable"]) expect(() => parseTackArgs(["plugin", action])).toThrow(CommanderError);
  });

  it("parses doctor --tools", () => {
    expect(parseTackArgs(["doctor", "--tools"])).toEqual({ mode: "doctor", profile: DEFAULT_RUN_PROFILE, dumpConfig: false, tools: true });
  });
});
