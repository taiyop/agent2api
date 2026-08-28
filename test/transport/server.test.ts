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
});
