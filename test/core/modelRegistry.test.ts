import { describe, expect, it } from "vitest";
import { Agent2APIError } from "../../src/core/errors.js";
import { StaticModelRegistry } from "../../src/core/modelRegistry.js";

const registry = new StaticModelRegistry({
  entries: [
    {
      id: "codex/default",
      target: { backend: "headless-core", agent: "codex", model: "default" }
    }
  ],
  aliases: { default: "codex/default" }
});

describe("StaticModelRegistry", () => {
  it("resolves canonical ids", () => {
    expect(registry.resolve("codex/default")).toEqual({ backend: "headless-core", agent: "codex", model: "default" });
  });

  it("resolves aliases without changing the target default model", () => {
    expect(registry.resolve("default")).toEqual({ backend: "headless-core", agent: "codex", model: "default" });
  });

  it("throws model_not_found", () => {
    expect(() => registry.resolve("missing")).toThrowError(
      expect.objectContaining<Partial<Agent2APIError>>({ code: "model_not_found", statusCode: 404 })
    );
  });

  it("uses a protocol-neutral fallback for unregistered canonical ids and aliases", () => {
    const dynamic = new StaticModelRegistry({
      entries: [],
      aliases: { luna: "codex/gpt-5.6-luna" },
      resolveUnknown(modelId) {
        const [agent, model] = modelId.split("/");
        if (!agent || !model) return undefined;
        return { id: modelId, target: { backend: "dynamic", agent, model } };
      }
    });

    expect(dynamic.resolve("codex/gpt-5.6-luna")).toEqual({
      backend: "dynamic",
      agent: "codex",
      model: "gpt-5.6-luna"
    });
    expect(dynamic.resolve("luna")).toEqual({ backend: "dynamic", agent: "codex", model: "gpt-5.6-luna" });
    expect(dynamic.list()).toEqual([]);
  });
});
