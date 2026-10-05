/**
 * Claude Agent SDK messages → the run's observation events (the proposed DSH
 * `SubagentRun.events` shape). Pure translation plus a small async queue.
 * Inner subagent transcripts, thinking, and the result-reporting tool stay
 * opaque.
 */
import type { SubagentRun } from "@deepseek-ai/dsh-subagent";
import type {} from "@tack/dsh-shims/subagent-events";

export type RunEvent = NonNullable<SubagentRun["events"]> extends AsyncIterable<infer E> ? E : never;

/** The SDK's internal tool that carries the structured result; it is not activity. */
const HIDDEN_TOOLS = new Set(["StructuredOutput"]);
const SUMMARY_LIMIT = 400;

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** The parts of an SDK message this translation reads. */
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  total_cost_usd?: number;
  num_turns?: number;
}

function summarize(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: ContentBlock) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat;
}

export class EventTranslator {
  private readonly hiddenCalls = new Set<string>();

  translate(message: SdkMessageLike): RunEvent[] {
    if (message.parent_tool_use_id) return [];
    const blocks = Array.isArray(message.message?.content) ? (message.message!.content as ContentBlock[]) : [];
    if (message.type === "assistant") {
      const events: RunEvent[] = [];
      for (const block of blocks) {
        if (block.type === "tool_use" && block.id !== undefined && block.name !== undefined) {
          if (HIDDEN_TOOLS.has(block.name)) {
            this.hiddenCalls.add(block.id);
            continue;
          }
          events.push({ type: "tool/start", id: block.id, name: block.name, input: block.input ?? null });
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          events.push({ type: "progress", text: block.text.trim() });
        }
      }
      return events;
    }
    if (message.type === "user") {
      return blocks
        .filter((block) => block.type === "tool_result" && block.tool_use_id !== undefined && !this.hiddenCalls.has(block.tool_use_id))
        .map((block) => ({ type: "tool/end", id: block.tool_use_id!, isError: block.is_error === true, summary: summarize(block.content) }));
    }
    if (message.type === "result") {
      return [
        {
          type: "usage",
          ...(message.total_cost_usd !== undefined && { costUsd: message.total_cost_usd }),
          ...(message.num_turns !== undefined && { turns: message.num_turns }),
        },
      ];
    }
    return [];
  }
}

/** A single-consumer async queue that ends when closed. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
