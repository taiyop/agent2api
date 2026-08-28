import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../../src/backends/fake.js";
import { StaticModelRegistry } from "../../../src/core/modelRegistry.js";
import { LabeledPromptRenderer } from "../../../src/core/promptRenderer.js";
import { AgentRunner } from "../../../src/core/runner.js";
import { OpenAIProtocolAdapter } from "../../../src/protocols/openai/index.js";

const servers: ReturnType<typeof Fastify>[] = [];

function createServer() {
  const server = Fastify({ logger: false });
  servers.push(server);
  const backend = new FakeAgentBackend({ output: "Hello." });
  const models = new StaticModelRegistry({
    entries: [{ id: "codex/default", ownedBy: "agent2api", target: { backend: "fake", agent: "codex", model: "default" } }]
  });
  new OpenAIProtocolAdapter().registerRoutes({
    server,
    prefix: "/v1",
    models,
    runner: new AgentRunner({ models, backends: [backend], promptRenderer: new LabeledPromptRenderer() }),
    createRequestContext: () => ({ signal: new AbortController().signal, complete() {} })
  });
  return { server, backend };
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("OpenAI protocol routes", () => {
  it("serves models from ModelRegistry", async () => {
    const { server } = createServer();
    const response = await server.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "list", data: [{ id: "codex/default", owned_by: "agent2api" }] });
  });

  it("serves chat completions through the canonical runner", async () => {
    const { server, backend } = createServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "codex/default", messages: [{ role: "user", content: "Hello" }] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "Hello." } }] });
    expect(backend.requests[0]?.prompt).toBe("[USER]\nHello");
  });

  it("serves Responses through the same canonical runner", async () => {
    const { server } = createServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "codex/default", input: "Hello" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "response", output: [{ content: [{ text: "Hello." }] }] });
  });

  it("ignores unexpected parameters instead of returning 400", async () => {
    const { server, backend } = createServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "codex/default",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.2,
        max_tokens: 100,
        cwd: "/tmp/ignored"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "chat.completion" });
    expect(backend.requests[0]).not.toHaveProperty("cwd");
  });

  it("maps canonical errors to OpenAI errors", async () => {
    const { server } = createServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "missing", messages: [{ role: "user", content: "Hello" }] }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "model_not_found", type: "invalid_request_error" } });
  });

  it("explicitly rejects unsupported generation endpoints", async () => {
    const { server } = createServer();
    const response = await server.inject({ method: "POST", url: "/v1/embeddings", payload: { input: "Hello" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unsupported_feature" } });
  });
});
