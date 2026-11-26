import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { parseConfig } from "../../src/config/schema.js";
import { createServer } from "../../src/transport/http/server.js";
import { createBenchServer, listen, resolveTarget } from "../../tools/bench/server.mjs";

const TOKEN = "bench-secret";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startApi(): Promise<string> {
  const config = parseConfig({
    server: { host: "127.0.0.1", port: 0, logging: false, auth: { bearerToken: TOKEN } },
    models: {
      entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }],
      aliases: {}
    }
  });
  const api = createServer(config, { backends: [new FakeAgentBackend({ output: "ok from fake" })] });
  await api.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => api.close());
  const address = api.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function startBench(options: Parameters<typeof createBenchServer>[0]): Promise<string> {
  const bench: Server = createBenchServer(options);
  await new Promise<void>((resolve) => bench.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => bench.close(() => resolve())));
  const address = bench.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function post(bench: string, route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${bench}/proxy${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: bench, ...headers },
    body: JSON.stringify(body)
  });
}

describe("Agent2API Bench", () => {
  it("serves the page and its settings without exposing the token", async () => {
    const bench = await startBench({ target: await startApi(), token: TOKEN });
    const page = await fetch(bench);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Agent2API");
    const config = await (await fetch(`${bench}/bench/config`)).json();
    expect(config).toMatchObject({ tokenConfigured: true });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });

  it("forwards Agent2API routes with the configured bearer token", async () => {
    const bench = await startBench({ target: await startApi(), token: TOKEN });
    expect((await fetch(`${bench}/proxy/health`)).status).toBe(200);
    const models = await (await fetch(`${bench}/proxy/v1/models`)).json() as { data: Array<{ id: string }> };
    expect(models.data.map((entry) => entry.id)).toContain("codex/default");

    const chat = await post(bench, "/v1/chat/completions", {
      model: "codex/default",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(chat.status).toBe(200);
    expect((await chat.json() as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("ok from fake");

    const stream = await post(bench, "/v1/responses", { model: "codex/default", input: "hi", stream: true });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const events = await stream.text();
    expect(events).toContain("ok from fake");
  });

  it("lets the page override the token and reports a wrong one as Agent2API does", async () => {
    const bench = await startBench({ target: await startApi() });
    expect((await fetch(`${bench}/proxy/v1/models`)).status).toBe(401);
    expect((await fetch(`${bench}/proxy/v1/models`, { headers: { "x-agent2api-token": TOKEN } })).status).toBe(200);
  });

  it("refuses foreign origins, unexpected hosts, and other routes", async () => {
    const bench = await startBench({ target: await startApi(), token: TOKEN });
    const body = { model: "codex/default", messages: [{ role: "user", content: "hi" }] };
    expect((await post(bench, "/v1/chat/completions", body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${bench}/proxy/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "text/plain", origin: bench }, body: JSON.stringify(body)
    })).status).toBe(415);
    expect((await fetch(`${bench}/proxy/v1/files`)).status).toBe(404);
    expect((await fetch(`${bench}/proxy/v1/models`, { method: "POST", headers: { origin: bench } })).status).toBe(405);
  });

  it("reports an unreachable Agent2API as a bench error", async () => {
    const bench = await startBench({ target: "http://127.0.0.1:9" });
    const response = await fetch(`${bench}/proxy/health`);
    expect(response.status).toBe(502);
    expect((await response.json() as { error: { message: string } }).error.message).toContain("Cannot reach Agent2API");
  });

  it("listens on any free port by default and refuses a taken fixed port", async () => {
    const free = createBenchServer({ target: "http://127.0.0.1:9" });
    const port = await listen(free, 0);
    cleanups.push(() => new Promise<void>((resolve) => free.close(() => resolve())));
    expect(port).toBeGreaterThan(0);

    const fixed = createBenchServer({ target: "http://127.0.0.1:9" });
    await expect(listen(fixed, port)).rejects.toThrow(/already in use.*--port/);
  });

  it("derives the target from an Agent2API config file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agent2api-bench-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, "agent2api.config.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "0.0.0.0", port: 9000, auth: { bearerToken: TOKEN } },
      interfaces: [{ type: "openai", mountPath: "/api" }]
    }));
    expect(resolveTarget({ configPath })).toEqual({ target: "http://127.0.0.1:9000", basePath: "/api", token: TOKEN });
    expect(resolveTarget({ configPath, target: "http://example.test:1/" }).target).toBe("http://example.test:1");
    expect(resolveTarget()).toEqual({ target: "http://127.0.0.1:8080", basePath: "", token: undefined });
  });
});
