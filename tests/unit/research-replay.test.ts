import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@rstest/core";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { MolabClient } from "../../packages/research/src/molab/client.js";
import { researchRequest } from "../../packages/research/src/dsh/web.js";
import { researchReplay } from "../../packages/research/src/tools/replay-tool.js";
import type { ResearchDeps } from "../../packages/research/src/tools/types.js";
import { parseTackArgs } from "../../packages/tack/src/cli.js";
import { spawnTack, tempHome } from "../helpers.js";

const page = { events: [{ id: "run1:e02:ExecutionCreated", at: "2026-11-10T12:00:00Z", kind: "execution",
  action: "ExecutionCreated", title: "model=a · e02 · queued", ref: "molab:experiment/e/run/run1/execution/e02",
  actor: null, commit: null, document: null, details: { mode: "resume", basedOnExecutionId: "e01" } }],
  total: 3, offset: 0, nextOffset: 1, asOf: "2026-11-10T12:10:00Z", historyAvailable: true, warnings: [] };
const requests: { method: string; url: string }[] = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method!, url: request.url! });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(request.url!.startsWith("/api/history/replay/document")
    ? { name: "protocol.md", relPath: "knowledges/protocol.md", body: "Original seed 7", commit: "a".repeat(40) } : page));
});
let url: string;
let home: string;
let client: MolabClient;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  url = `http://127.0.0.1:${address.port}`;
  client = new MolabClient({ url });
  home = tempHome();
});
beforeEach(() => { requests.length = 0; });
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe("research replay", () => {
  it("parses read-only CLI filters without model or amendment settings", () => {
    expect(parseTackArgs(["research", "replay", "--experiment", "e", "--kind", "execution", "--offset", "10", "--limit", "20", "--as-of", page.asOf, "--json", "--molab-url", "http://molab.test"]))
      .toEqual({ mode: "research", action: "replay", query: { experimentId: "e", kind: "execution", offset: 10, limit: 20, asOf: page.asOf }, json: true, molabUrl: "http://molab.test" });
  });

  it("reads through the same client/tool contract without a delegation or writes", async () => {
    const tool = researchReplay({ molab: client } as ResearchDeps);
    const result = await tool.execute({ experimentId: "e", limit: 1 }, { signal: new AbortController().signal });
    expect(result.meta).toEqual(page);
    expect(JSON.parse(result.text).nextOffset).toBe(1);
    expect(requests).toEqual([{ method: "GET", url: "/api/history/replay?experimentId=e&offset=0&limit=1" }]);
  });

  it("proxies replay and historical versions through the authenticated browser route", async () => {
    const deps = { molab: client } as ResearchDeps;
    const response = await researchRequest(deps, new Request("http://tack.test/api/tack/research?replay=1&offset=1&limit=2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(page);
    const version = await researchRequest(deps, new Request(`http://tack.test/api/tack/research?${new URLSearchParams({ replay: "1", document: "knowledges/protocol.md", commit: "a".repeat(40) })}`));
    expect(await version.json()).toMatchObject({ body: "Original seed 7" });
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("rejects invalid pages before calling Molab", async () => {
    const response = await researchRequest({ molab: client } as ResearchDeps, new Request("http://tack.test/api/tack/research?replay=1&limit=1000"));
    expect(response.status).toBe(400);
    expect(() => client.replay({ offset: -1 })).toThrow();
    expect(requests).toHaveLength(0);
  });

  it("reads the exact historical plan through the same replay tool", async () => {
    const tool = researchReplay({ molab: client } as ResearchDeps);
    const result = await tool.execute({ document: "knowledges/protocol.md", commit: "a".repeat(40) }, { signal: new AbortController().signal });
    expect(result.meta).toMatchObject({ body: "Original seed 7" });
    await expect(tool.execute({ document: "knowledges/protocol.md" }, { signal: new AbortController().signal })).rejects.toThrow("both document and commit");
    expect(requests).toHaveLength(1);
  });

  it("runs the built CLI without booting a model and preserves the pagination cursor", async () => {
    const result = await spawnTack(["research", "replay", "--molab-url", url, "--json"], { home });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(page);
    expect(result.stderr).toBe("");
    expect(requests.every(request => request.method === "GET")).toBe(true);
    const text = await spawnTack(["research", "replay", "--molab-url", url], { home });
    expect(text.stdout).toContain("resume ← e01");
    expect(text.stdout).toContain(`--offset 1 --as-of ${page.asOf}`);
  });
});
