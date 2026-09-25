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
    expect(parseTackArgs(["doctor"])).toEqual({ mode: "doctor", profile: DEFAULT_RUN_PROFILE, dumpConfig: false });
    expect(parseTackArgs(["doctor", "--dump-config", "--profile", "web"])).toEqual({ mode: "doctor", profile: "web", dumpConfig: true });
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
