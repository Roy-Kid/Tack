/**
 * The supervisor's tool mask (the supervise profile hides write/edit from its agent).
 */
import { describe, expect, it } from "@rstest/core";
import { apply as applyToolMask } from "../../packages/plugins/src/tool-mask.js";

/** A fake agent whose tool registry knows `visible` and records live restrictions. */
function fakeAgent(sessionId: string, visible: readonly string[]) {
  const active = new Set<string>();
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
        restrict: ({ deny }: { deny: readonly string[] }) => {
          const name = deny[0]!;
          if (!visible.includes(name)) throw new Error(`unknown tool ${name}`);
          active.add(name);
          return () => active.delete(name);
        },
      },
    },
  };
  return { agent, masked: () => [...active].sort() };
}

function maskHarness(config: Parameters<typeof applyToolMask>[1]) {
  const listeners = new Map<string, (...args: never[]) => void>();
  applyToolMask(
    {
      on: (event: string, listener: (...args: never[]) => void) => (listeners.set(event, listener), () => {}),
    } as never,
    config,
  );
  return (event: string, ...args: unknown[]) => (listeners.get(event) as ((...args: unknown[]) => void) | undefined)?.(...args);
}

describe("tool mask", () => {
  it("hides the denied tools each agent can see", () => {
    const emit = maskHarness({ deny: ["write", "edit", "bash"] });
    const { agent, masked } = fakeAgent("s1", ["read", "write", "edit"]);
    emit("agent/created", { agent });
    expect(masked()).toEqual(["edit", "write"]);
  });
});
