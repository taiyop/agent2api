import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { parseConfig } from "../../src/config/schema.js";
import { createServer } from "../../src/transport/http/server.js";

const servers: ReturnType<typeof createServer>[] = [];

async function createClient() {
  const config = parseConfig({
    server: { host: "127.0.0.1", port: 0, logging: false, heartbeatIntervalMs: 0 },
    models: {
      entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }],
      aliases: { default: "codex/default" }
    }
  });
  const server = createServer(config, { backends: [new FakeAgentBackend({ output: "Hello from FakeBackend." })] });
  servers.push(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return new OpenAI({ apiKey: "dummy", baseURL: `http://127.0.0.1:${address.port}/v1` });
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("OpenAI JavaScript SDK compatibility", () => {
  it("supports chat.completions.create", async () => {
    const client = await createClient();
    const response = await client.chat.completions.create({
      model: "codex/default",
      messages: [{ role: "user", content: "Hello" }]
    });
    expect(response.choices[0]?.message.content).toBe("Hello from FakeBackend.");
  });

  it("supports responses.create", async () => {
    const client = await createClient();
    const response = await client.responses.create({ model: "codex/default", input: "Hello" });
    expect(response.output_text).toBe("Hello from FakeBackend.");
  });

  it("supports streamed chat completions", async () => {
    const client = await createClient();
    const stream = await client.chat.completions.create({
      model: "codex/default",
      messages: [{ role: "user", content: "Hello" }],
      stream: true
    });
    let output = "";
    for await (const chunk of stream) output += chunk.choices[0]?.delta.content ?? "";
    expect(output).toBe("Hello from FakeBackend.");
  });

  it("supports streamed Responses events", async () => {
    const client = await createClient();
    const stream = await client.responses.create({ model: "codex/default", input: "Hello", stream: true });
    let output = "";
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") output += event.delta;
    }
    expect(output).toBe("Hello from FakeBackend.");
  });
});
