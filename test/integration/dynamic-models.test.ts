import type { HeadlessRunOptions } from "@headless-core/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadlessCoreBackend } from "../../src/backends/headless-core/backend.js";
import { parseConfig } from "../../src/config/schema.js";
import { createServer } from "../../src/transport/http/server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("dynamic headless-core model resolution", () => {
  it("runs an unregistered canonical model and delegates availability to headless-core", async () => {
    const captured: HeadlessRunOptions[] = [];
    const headless = {
      run: vi.fn(async (options: HeadlessRunOptions) => {
        captured.push(options);
        return "Luna response";
      })
    };
    const config = parseConfig({
      server: { logging: false },
      models: { entries: [], aliases: {} }
    });
    const server = createServer(config, {
      backends: [new HeadlessCoreBackend({ cwd: "/project", headless })]
    });
    servers.push(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-5.6-luna/low",
        messages: [{ role: "user", content: "Hello" }],
        stream: true
      })
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Luna response");
    expect(captured[0]?.agent).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "low"
    });

    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "codex/gpt-5.6-luna/low",
        messages: [{ role: "user", content: "Override" }],
        reasoning: { effort: "high" }
      }
    });
    expect(captured[1]?.agent).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "high"
    });

    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "codex/gpt-5.6-luna",
        messages: [{ role: "user", content: "No effort" }]
      }
    });
    expect(captured[2]?.agent).toEqual({ provider: "codex", model: "gpt-5.6-luna" });

    const unsupported = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "agy/custom/low",
        messages: [{ role: "user", content: "Agy effort" }]
      }
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({ error: { code: "unsupported_value", param: "reasoning.effort" } });
    expect(captured).toHaveLength(3);
  });
});
