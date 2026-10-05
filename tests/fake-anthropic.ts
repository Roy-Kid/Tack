/**
 * A scripted Anthropic Messages endpoint for delegated-agent tests.
 *
 * The Claude Agent SDK reaches it through `ANTHROPIC_BASE_URL` (the provider's
 * `baseUrl` config), so tests run the real Claude Code loop, tools, hooks, and
 * permission callbacks without an Anthropic key.
 *
 * Agent steps (requests that offer tools) consume the script in order; other
 * requests get a fixed short reply and never consume it. A `hold` step never
 * answers, so a test can cancel a run mid-request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ANTHROPIC_KEY = "sk-ant-tack-fake";

export type ClaudeStep = { text: string } | { tool: string; input: Record<string, unknown> } | { hold: true };

export interface AnthropicMessage {
  role: string;
  content: unknown;
}

export interface RecordedAnthropicRequest {
  model: string;
  tools: string[];
  messages: AnthropicMessage[];
  apiKey: string | undefined;
  agentStep: boolean;
}

export interface FakeAnthropic {
  /** Base URL for `ANTHROPIC_BASE_URL`, e.g. http://127.0.0.1:1234 */
  baseUrl: string;
  script(steps: ClaudeStep[]): void;
  readonly requests: RecordedAnthropicRequest[];
  agentRequests(): RecordedAnthropicRequest[];
  /** Resolves when a held request arrives. */
  held(): Promise<void>;
  /** Resolves when a held request's connection closes (the client went away). */
  heldClosed(): Promise<void>;
  close(): Promise<void>;
}

/** Every `tool_result` block across a request's messages. */
export function toolResults(request: RecordedAnthropicRequest): { tool_use_id: string; is_error?: boolean; content: unknown }[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as { type: string }[]).filter((block) => block.type === "tool_result") : [],
  ) as never;
}

export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

const HOUSEKEEPING_REPLY = "ok";
const EXHAUSTED_REPLY = "(fake anthropic: script exhausted)";

export async function startFakeAnthropic(steps: ClaudeStep[] = []): Promise<FakeAnthropic> {
  let queue = [...steps];
  const requests: RecordedAnthropicRequest[] = [];
  let calls = 0;
  let onHeld: (() => void) | undefined;
  let onHeldClosed: (() => void) | undefined;
  const heldArrived = new Promise<void>((resolve) => (onHeld = resolve));
  const heldGone = new Promise<void>((resolve) => (onHeldClosed = resolve));

  const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const reply = (res: ServerResponse, body: { model: string; stream?: boolean }, step: { text: string } | { tool: string; input: Record<string, unknown> }) => {
    const id = ++calls;
    const block =
      "tool" in step ? { type: "tool_use", id: `toolu_fake_${id}`, name: step.tool, input: step.input } : { type: "text", text: step.text };
    const stopReason = "tool" in step ? "tool_use" : "end_turn";
    const message = { id: `msg_fake_${id}`, type: "message", role: "assistant", model: body.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, "message_start", { type: "message_start", message });
    if (block.type === "tool_use") {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { ...block, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
      res.setHeader("content-type", "application/json");
      res.end(path.endsWith("/count_tokens") ? JSON.stringify({ input_tokens: 10 }) : "{}");
      return;
    }
    const body = JSON.parse(raw) as { model: string; stream?: boolean; messages?: AnthropicMessage[]; tools?: { name: string }[] };
    const tools = (body.tools ?? []).map((tool) => tool.name);
    const agentStep = tools.length > 0;
    const header = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "");
    requests.push({ model: body.model, tools, messages: body.messages ?? [], apiKey: Array.isArray(header) ? header[0] : header, agentStep });
    const step = agentStep ? (queue.shift() ?? { text: EXHAUSTED_REPLY }) : { text: HOUSEKEEPING_REPLY };
    if ("hold" in step) {
      res.on("close", () => onHeldClosed?.());
      onHeld?.();
      return;
    }
    reply(res, body, step);
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      try {
        handle(req, res, raw);
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    script: (next) => {
      queue = [...next];
    },
    requests,
    agentRequests: () => requests.filter((request) => request.agentStep),
    held: () => heldArrived,
    heldClosed: () => heldGone,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
