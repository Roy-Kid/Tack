import { describe, expect, it } from "@rstest/core";
import { relabelChunk, type LineState } from "../../packages/tack/src/terminal.js";

const run = (chunks: string[]) => {
  const state: LineState = { atLineStart: true };
  return chunks.map((chunk) => relabelChunk(chunk, state)).join("");
};

describe("relabelChunk", () => {
  it("relabels runtime lines as Tack's", () => {
    expect(run(["dsh: something failed\n"])).toBe("tack: something failed\n");
    expect(run(["dsh web: http://127.0.0.1:1/\n"])).toBe("tack web: http://127.0.0.1:1/\n");
  });

  it("only rewrites at line starts, across writes", () => {
    expect(run(["answer mentions dsh: inline\n", "dsh: next line\n"])).toBe("answer mentions dsh: inline\ntack: next line\n");
    expect(run(["partial ", "dsh: not a line start\n"])).toBe("partial dsh: not a line start\n");
    expect(run(["a\ndsh: b\ndsh: c"])).toBe("a\ntack: b\ntack: c");
  });

  it("passes unlabelled output through unchanged", () => {
    const json = '{"type":"status","phase":"turn_start"}\n';
    expect(run([json, "plain text"])).toBe(json + "plain text");
  });
});
