/**
 * A scripted OpenAI-compatible model endpoint for end-to-end tests.
 *
 * Tack reaches it the way a user reaches any gateway (`tack provider add
 * <id> --api openai-completions --base-url <url> --model <id>`), so tests
 * exercise the real agent loop, tools, and persistence without a provider key.
 *
 * Agent steps (requests that offer tools) consume the script in order; other
 * requests (session titles and similar housekeeping) get a fixed short reply
 * and never consume it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_PROVIDER = "fake";
export const FAKE_MODEL = "fake-1";
export const FAKE_KEY_ENV = "TACK_FAKE_MODEL_KEY";
export const FAKE_KEY = "sk-tack-fake";
export const HOUSEKEEPING_REPLY = "Test session";

export type Step = { text: string } | { tool: string; arguments: Record<string, unknown> };

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface RecordedRequest {
  model: string;
  messages: ChatMessage[];
  tools: string[];
  authorization: string | undefined;
  /** Whether this request consumed a script step. */
  agentStep: boolean;
}

export interface FakeModel {
  /** Base URL for `--base-url`, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** Replace the remaining script. */
  script(steps: Step[]): void;
  /** Every request seen so far. */
  readonly requests: RecordedRequest[];
  /** Agent-step requests only. */
  agentRequests(): RecordedRequest[];
  close(): Promise<void>;
}

/** Text of a message's content, whether a string or content parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("");
  }
  return "";
}

const EXHAUSTED_REPLY = "(fake model: script exhausted)";

export async function startFakeModel(steps: Step[] = []): Promise<FakeModel> {
  let queue = [...steps];
  const requests: RecordedRequest[] = [];
  let calls = 0;

  const reply = (res: ServerResponse, body: { model: string; stream?: boolean }, step: Step) => {
    const base = { id: `chatcmpl-${++calls}`, created: Math.floor(Date.now() / 1000), model: body.model };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const toolCall =
      "tool" in step ? { index: 0, id: `call_${calls}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.arguments) } } : undefined;
    const finish = toolCall === undefined ? "stop" : "tool_calls";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}) =>
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
      chunk(toolCall === undefined ? { role: "assistant", content: (step as { text: string }).text } : { role: "assistant", tool_calls: [toolCall] }, null);
      chunk({}, finish, { usage });
      res.end("data: [DONE]\n\n");
      return;
    }
    const message = toolCall === undefined ? { role: "assistant", content: (step as { text: string }).text } : { role: "assistant", content: null, tool_calls: [toolCall] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
  };

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "GET" && path.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: FAKE_MODEL, object: "model", owned_by: "tack-tests" }] }));
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const body = JSON.parse(raw) as { model: string; stream?: boolean; messages?: ChatMessage[]; tools?: { function: { name: string } }[] };
    const tools = (body.tools ?? []).map((tool) => tool.function.name);
    const agentStep = tools.length > 0;
    requests.push({ model: body.model, messages: body.messages ?? [], tools, authorization: req.headers.authorization, agentStep });
    const step = agentStep ? (queue.shift() ?? { text: EXHAUSTED_REPLY }) : { text: HOUSEKEEPING_REPLY };
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
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    script: (next) => {
      queue = [...next];
    },
    requests,
    agentRequests: () => requests.filter((request) => request.agentStep),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The `tack` arguments that route a profile set to the fake model, in order. */
export function fakeProviderCommands(model: FakeModel): string[][] {
  return [
    ["provider", "add", FAKE_PROVIDER, "--api", "openai-completions", "--base-url", model.baseUrl, "--model", FAKE_MODEL, "--api-key-env", FAKE_KEY_ENV],
    ["model", "use", `${FAKE_PROVIDER}/${FAKE_MODEL}`],
  ];
}
