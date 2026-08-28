import { describe, expect, it } from "vitest";
import { FakeAgentBackend } from "../../src/backends/fake.js";
import { StaticModelRegistry } from "../../src/core/modelRegistry.js";
import { LabeledPromptRenderer } from "../../src/core/promptRenderer.js";
import { AgentRunner } from "../../src/core/runner.js";

describe("AgentRunner", () => {
  it("resolves, renders, and invokes a backend", async () => {
    const backend = new FakeAgentBackend({ output: "done" });
    const runner = new AgentRunner({
      models: new StaticModelRegistry({
        entries: [{ id: "codex/default", target: { backend: "fake", agent: "codex", model: "default" } }]
      }),
      backends: [backend],
      promptRenderer: new LabeledPromptRenderer()
    });
    const response = await runner.execute(
      {
        requestId: "req_1",
        model: "codex/default",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        reasoning: { effort: "high" }
      },
      { signal: new AbortController().signal }
    );

    expect(response.content).toEqual([{ type: "text", text: "done" }]);
    expect(backend.requests[0]).toMatchObject({
      modelId: "codex/default",
      prompt: "[USER]\nHello",
      reasoning: { effort: "high" },
      target: { backend: "fake", agent: "codex", model: "default" }
    });
  });
});
