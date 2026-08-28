import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { parseConfig } from "../../src/config/schema.js";
import { createServer } from "../../src/transport/http/server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("client disconnect propagation", () => {
  it("aborts the Agent2API backend through the Surface context signal", async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let aborted = false;
    const backend = new FakeAgentBackend({
      execute: async (_request, context) => {
        notifyStarted?.();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (context.signal.aborted) {
            onAbort();
            return;
          }
          context.signal.addEventListener("abort", onAbort, { once: true });
        });
        return { output: "unreachable" };
      }
    });
    const config = parseConfig({
      server: { host: "127.0.0.1", port: 0, logging: false },
      models: {
        entries: [{ id: "codex/default", backend: "fake", agent: "codex", model: "default" }]
      }
    });
    const server = createServer(config, { backends: [backend] });
    servers.push(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "connection": "close", "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex/default",
        messages: [{ role: "user", content: "Hello" }]
      }),
      signal: controller.signal
    });
    await started;
    controller.abort();
    await pending.catch(() => undefined);

    const deadline = Date.now() + 1_000;
    while (!aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(aborted).toBe(true);
    server.server.closeAllConnections?.();
  });
});
