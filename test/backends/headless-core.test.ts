import { describe, expect, it, vi } from "vitest";
import type { HeadlessRunOptions } from "@headless-core/core";
import { HeadlessCoreBackend } from "../../src/backends/headless-core/backend.js";
import { mapHeadlessCoreError } from "../../src/backends/headless-core/errorMapper.js";
import { resolveHeadlessCoreModel } from "../../src/backends/headless-core/modelMapper.js";

function request() {
  return {
    requestId: "req_1",
    modelId: "codex/default",
    target: { backend: "headless-core", agent: "codex", model: "default" },
    prompt: "[USER]\nHello",
    reasoning: { effort: "high" }
  };
}

describe("HeadlessCoreBackend", () => {
  it("preserves default model and forwards reasoning, signal, timeout, and prompt", async () => {
    let captured: HeadlessRunOptions | undefined;
    const headless = {
      run: vi.fn(async (options: HeadlessRunOptions) => {
        captured = options;
        await options.onProgress?.({ state: "running", partialOutput: "stderr or stdout" });
        return "Hello.";
      })
    };
    const backend = new HeadlessCoreBackend({ cwd: "/project", timeoutMs: 120_000, headless });
    const controller = new AbortController();
    const progress = vi.fn();
    await expect(backend.execute(request(), { signal: controller.signal, timeoutMs: 5000, onProgress: progress }))
      .resolves.toEqual({ output: "Hello." });

    expect(captured).toMatchObject({
      agent: { provider: "codex", model: "default", reasoningEffort: "high" },
      prompt: "[USER]\nHello",
      signal: controller.signal,
      timeoutMs: 5000
    });
    expect(progress).toHaveBeenCalledWith({ type: "execution.output", stream: "unknown" });
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ delta: expect.anything() }));
  });

  it("passes an already-aborted signal through and maps cancellation", async () => {
    let receivedSignal: AbortSignal | undefined;
    const backend = new HeadlessCoreBackend({
      cwd: "/project",
      headless: {
        async run(options) {
          receivedSignal = options.signal;
          throw new Error("stopped");
        }
      }
    });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.execute(request(), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("mapHeadlessCoreError", () => {
  it("maps rate limits, timeouts, and authentication failures", () => {
    const signal = new AbortController().signal;
    expect(mapHeadlessCoreError({ cause: { error: { kind: "rate_limit" } } }, signal)).toMatchObject({ code: "rate_limit" });
    expect(mapHeadlessCoreError(new Error("Command timed out"), signal)).toMatchObject({ code: "timeout" });
    expect(mapHeadlessCoreError(new Error("not authenticated"), signal)).toMatchObject({
      code: "backend_unavailable",
      message: expect.stringContaining("already authenticated")
    });
  });
});

describe("resolveHeadlessCoreModel", () => {
  it("routes supported agent/model ids without checking model availability", () => {
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna")).toEqual({
      id: "codex/gpt-5.6-luna",
      target: { backend: "headless-core", agent: "codex", model: "gpt-5.6-luna" },
      ownedBy: "agent2api"
    });
    expect(resolveHeadlessCoreModel("agy/custom")).toMatchObject({ capabilities: { reasoningEffort: false } });
  });

  it("extracts an optional recognized reasoning effort suffix", () => {
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna/low")).toEqual({
      id: "codex/gpt-5.6-luna/low",
      target: { backend: "headless-core", agent: "codex", model: "gpt-5.6-luna" },
      defaultReasoning: { effort: "low" },
      ownedBy: "agent2api"
    });
    expect(resolveHeadlessCoreModel("codex/vendor/model-name")).toMatchObject({
      target: { model: "vendor/model-name" }
    });
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna/default")).not.toHaveProperty("defaultReasoning");
  });

  it.each(["codex", "unknown/model", "/model", "codex/", "codex//model", "codex/model/", "codex/model with spaces"])(
    "does not route malformed or unsupported id %s",
    (modelId) => expect(resolveHeadlessCoreModel(modelId)).toBeUndefined()
  );
});
