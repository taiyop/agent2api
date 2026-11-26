import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { parseConfig } from "../../src/config/schema.js";
import { createServer } from "../../src/transport/http/server.js";

const servers: ReturnType<typeof createServer>[] = [];

function authenticatedServer() {
  const config = parseConfig({
    server: { logging: false, auth: { bearerToken: "secret" } },
    models: { entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }] }
  });
  const server = createServer(config, { backends: [new FakeAgentBackend()] });
  servers.push(server);
  return server;
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("HTTP transport", () => {
  it("keeps health public and protects API routes with optional bearer auth", async () => {
    const server = authenticatedServer();
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(401);
    expect((await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer secret" }
    })).statusCode).toBe(200);
  });

  it("mounts the OpenAI surface before its native /v1 paths", async () => {
    const config = parseConfig({
      server: { logging: false },
      interfaces: [{ type: "openai", mountPath: "/api" }],
      models: { entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }] }
    });
    const server = createServer(config, { backends: [new FakeAgentBackend()] });
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/api/v1/models" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("serves public Swagger docs and an OpenAPI document without exposing the bearer token", async () => {
    const server = authenticatedServer();
    const page = await server.inject({ method: "GET", url: "/docs" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("AI Agent connection prompt");
    expect(page.body).not.toContain("secret");

    const spec = await server.inject({ method: "GET", url: "/openapi.json", headers: { host: "localhost:9999" } });
    expect(spec.statusCode).toBe(200);
    const document = spec.json();
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "http://localhost:9999" }]);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(["/health", "/v1/models", "/v1/chat/completions", "/v1/responses"])
    );
    expect(document.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(spec.body).not.toContain("secret");

    const asset = await server.inject({ method: "GET", url: "/docs/assets/swagger-ui-bundle.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect((await server.inject({ method: "GET", url: "/docs/assets/package.json" })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/docs/assets/..%2Fpackage.json" })).statusCode).toBe(404);
  });

  it("documents mounted interfaces and can disable docs", async () => {
    const mounted = createServer(parseConfig({
      server: { logging: false },
      interfaces: [{ type: "openai", mountPath: "/api" }],
      models: { entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }] }
    }), { backends: [new FakeAgentBackend()] });
    servers.push(mounted);
    const document = (await mounted.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(document.paths["/api/v1/chat/completions"]).toBeDefined();
    expect(document.paths["/v1/chat/completions"]).toBeUndefined();
    expect(document.components.securitySchemes).toBeUndefined();

    const disabled = createServer(parseConfig({
      server: { logging: false, docs: false, auth: { bearerToken: "secret" } },
      models: { entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }] }
    }), { backends: [new FakeAgentBackend()] });
    servers.push(disabled);
    expect((await disabled.inject({ method: "GET", url: "/docs" })).statusCode).toBe(401);
    expect((await disabled.inject({ method: "GET", url: "/docs", headers: { authorization: "Bearer secret" } })).statusCode).toBe(404);
  });
});
