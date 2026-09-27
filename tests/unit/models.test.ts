import { describe, expect, it } from "@rstest/core";
import { formatSelection, parseSelection } from "../../packages/tack/src/models.js";

describe("parseSelection", () => {
  it("splits at the first slash so model ids may contain slashes", () => {
    expect(parseSelection("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(parseSelection("openrouter/meta-llama/llama-4")).toEqual({ provider: "openrouter", model: "meta-llama/llama-4" });
  });

  it("rejects values without both parts", () => {
    for (const value of ["", "anthropic", "anthropic/", "/model"]) expect(() => parseSelection(value)).toThrow();
  });

  it("formats selections", () => {
    expect(formatSelection({ provider: "a", model: "b" })).toBe("a/b");
    expect(formatSelection({ provider: "a", model: "b", reasoningEffort: "high" })).toBe("a/b (reasoning: high)");
  });
});
