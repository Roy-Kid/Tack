import { describe, expect, it } from "@rstest/core";
import { apply as applyHeadless, HEADLESS_STARTUP_SERVICE, jsonRequested } from "../../packages/plugins/src/headless-startup.js";
import { apply as applyWeb, WEB_STARTUP_SERVICE } from "../../packages/plugins/src/web-startup.js";
import type { AppContext, ProcessIo } from "../../packages/plugins/src/cmdline.js";

function harness(args: string[], stdinIsTty = true) {
  const provided = new Map<string, unknown>();
  const exits: number[] = [];
  let stdout = "";
  let stderr = "";
  const ctx = {
    get(name: string) {
      if (name === "cmdlineArgs") return { get: () => args };
      if (name === "appExit") return (code: number) => void exits.push(code);
      return undefined;
    },
    provide(name: string, value: unknown) {
      provided.set(name, value);
    },
  } as AppContext;
  const io: ProcessIo = {
    stdinIsTty: () => stdinIsTty,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  };
  return { ctx, io, provided, exits, out: () => stdout, err: () => stderr };
}

describe("tack-headless-startup", () => {
  it("publishes the joined task and options", () => {
    const h = harness(["--json", "--session-id", "s1", "run", "the", "tests"]);
    applyHeadless(h.ctx, undefined, h.io);
    expect(h.provided.get(HEADLESS_STARTUP_SERVICE)).toEqual({ task: "run the tests", sessionId: "s1", json: true });
    expect(h.exits).toEqual([]);
  });

  it("leaves the task undefined when stdin is piped and no task is given", () => {
    const h = harness([], false);
    applyHeadless(h.ctx, undefined, h.io);
    expect(h.provided.get(HEADLESS_STARTUP_SERVICE)).toEqual({ task: undefined, sessionId: undefined, json: false });
  });

  it("prints Tack help and exits 0 without publishing", () => {
    const h = harness(["--help"]);
    applyHeadless(h.ctx, undefined, h.io);
    expect(h.out()).toContain("Usage: tack run");
    expect(h.exits).toEqual([0]);
    expect(h.provided.size).toBe(0);
  });

  it("rejects a missing task on an interactive stdin, and `-` mixed with words", () => {
    for (const args of [[], ["-", "more"], ["   "]]) {
      const h = harness(args, true);
      applyHeadless(h.ctx, undefined, h.io);
      expect(h.exits).toEqual([1]);
      expect(h.provided.size).toBe(0);
    }
  });

  it("reports usage errors as one JSON event when --json is requested", () => {
    const h = harness(["--json", "--session-id", " "]);
    applyHeadless(h.ctx, undefined, h.io);
    expect(h.exits).toEqual([1]);
    const event = JSON.parse(h.out().trim()) as { type: string };
    expect(event.type).toBe("error");
  });

  it("detects --json only as a real flag", () => {
    expect(jsonRequested(["--json"])).toBe(true);
    expect(jsonRequested(["--session-id", "--json"])).toBe(false);
    expect(jsonRequested(["--", "--json"])).toBe(false);
  });
});

describe("tack-web-startup", () => {
  it("publishes forwarded web flags", () => {
    const h = harness(["--port", "0", "--no-open", "--host", "127.0.0.1", "--trusted-host", "a", "b"]);
    applyWeb(h.ctx, undefined, h.io);
    expect(h.provided.get(WEB_STARTUP_SERVICE)).toEqual({ openBrowser: false, host: "127.0.0.1", port: 0, trustedHosts: ["a", "b"] });
  });

  it("defaults to opening the browser with no host or port", () => {
    const h = harness([]);
    applyWeb(h.ctx, undefined, h.io);
    expect(h.provided.get(WEB_STARTUP_SERVICE)).toEqual({ openBrowser: true, trustedHosts: [] });
  });

  it("rejects an unsafe host and a non-numeric port", () => {
    for (const args of [["--host", "0.0.0.0"], ["--port", "x"]]) {
      const h = harness(args);
      applyWeb(h.ctx, undefined, h.io);
      expect(h.exits).toEqual([1]);
      expect(h.provided.size).toBe(0);
    }
  });

  it("prints Tack help", () => {
    const h = harness(["-h"]);
    applyWeb(h.ctx, undefined, h.io);
    expect(h.out()).toContain("Usage: tack web");
    expect(h.exits).toEqual([0]);
  });
});
