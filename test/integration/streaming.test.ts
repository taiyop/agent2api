import http from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { StaticModelRegistry } from "../../src/core/modelRegistry.js";
import { LabeledPromptRenderer } from "../../src/core/promptRenderer.js";
import { AgentRunner } from "../../src/core/runner.js";
import { OpenAIProtocolAdapter } from "../../src/protocols/openai/index.js";
import { createHttpRequestContext } from "../../src/transport/http/requestContext.js";

const servers: ReturnType<typeof Fastify>[] = [];

function configure(backend: FakeAgentBackend, heartbeatIntervalMs = 0) {
  const server = Fastify({ logger: false });
  servers.push(server);
  const models = new StaticModelRegistry({
    entries: [{ id: "codex/default", target: { backend: "fake", agent: "codex", model: "default" } }]
  });
  new OpenAIProtocolAdapter().registerRoutes({
    server,
    prefix: "/v1",
    models,
    runner: new AgentRunner({ models, backends: [backend], promptRenderer: new LabeledPromptRenderer() }),
    heartbeatIntervalMs,
    createRequestContext: createHttpRequestContext
  });
  return server;
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("OpenAI SSE", () => {
  it("streams the final answer as a chat delta, finish chunk, and DONE", async () => {
    const server = configure(new FakeAgentBackend({ output: "Hello." }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "codex/default", messages: [{ role: "user", content: "Hello" }], stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"delta":{"content":"Hello."}');
    expect(response.body).toContain('"finish_reason":"stop"');
    expect(response.body).toContain("data: [DONE]");
  });

  it("streams Responses events without exposing backend progress", async () => {
    const server = configure(new FakeAgentBackend({ output: "Hello." }));
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "codex/default", input: "Hello", stream: true }
    });
    expect(response.body).toContain("event: response.created");
    expect(response.body).toContain("event: response.output_text.delta");
    expect(response.body).toContain('"delta":"Hello."');
    expect(response.body).toContain("event: response.completed");
    expect(response.body).toContain("data: [DONE]");
  });

  it("sends heartbeat comments while the backend is running", async () => {
    const backend = new FakeAgentBackend({
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { output: "done" };
      }
    });
    const server = configure(backend, 5);
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "codex/default", messages: [{ role: "user", content: "Hello" }], stream: true }
    });
    expect(response.body).toContain(": heartbeat\n\n");
  });

  it("encodes model errors after an SSE stream has started", async () => {
    const server = configure(new FakeAgentBackend());
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "missing", messages: [{ role: "user", content: "Hello" }], stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain('"code":"model_not_found"');
    expect(response.body).toContain("data: [DONE]");
  });

  it("propagates a client disconnect to the backend AbortSignal", async () => {
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const backend = new FakeAgentBackend({
      execute(_request, context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            markAborted();
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
    });
    const server = configure(backend);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({
        model: "codex/default",
        messages: [{ role: "user", content: "Hello" }],
        stream: true
      });
      const client = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      });
      client.once("response", (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      client.once("error", reject);
      client.end(payload);
    });

    await expect(Promise.race([
      aborted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not propagated")), 1000))
    ])).resolves.toBeUndefined();
  });
});
