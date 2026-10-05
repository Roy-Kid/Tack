/**
 * TEMPORARY SHIM — proposed upstream for DeepSeek Harness.
 *
 * Adds one optional, observation-only member to DSH's own `SubagentRun`:
 * the run's live event stream. It is not a Tack type: it augments the DSH
 * interface in place, so providers and consumers keep speaking only the DSH
 * contract. A run without `events` is an opaque run and keeps working.
 *
 * Remove when `@deepseek-ai/dsh-subagent` ships `SubagentRun.events`: bump the
 * DSH pin, delete this package and the type-only imports that load it
 * (`@tack/delegate`, `@tack/agent-claude`); no other code changes.
 */
import "@deepseek-ai/dsh-subagent";

declare module "@deepseek-ai/dsh-subagent" {
  interface SubagentRun {
    /**
     * What the child is doing, as it happens. Pure observations: no callbacks,
     * no control (permissions go through the host's approval service). The
     * iterable ends when the run settles.
     */
    readonly events?: AsyncIterable<
      | { readonly type: "progress"; readonly text: string }
      | { readonly type: "tool/start"; readonly id: string; readonly name: string; readonly input: unknown }
      | { readonly type: "tool/end"; readonly id: string; readonly isError: boolean; readonly summary: string }
      | { readonly type: "file/changed"; readonly path: string; readonly change: "created" | "modified" | "deleted" }
      | { readonly type: "usage"; readonly costUsd?: number; readonly turns?: number }
    >;
  }
}
