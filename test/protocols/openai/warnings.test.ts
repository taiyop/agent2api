import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { logOpenAIWarnings } from "../../../src/protocols/openai/warnings.js";

describe("OpenAI warning logging", () => {
  it("logs ignored parameter names without their values", () => {
    const warn = vi.fn();
    const request = { id: "req-1", log: { warn } } as unknown as FastifyRequest;
    logOpenAIWarnings(request, [
      { code: "ignored_parameter", param: "request.temperature", message: "ignored" },
      { code: "ignored_parameter", param: "request.cwd", message: "ignored" }
    ]);

    expect(warn).toHaveBeenCalledWith({
      requestId: "req-1",
      protocol: "openai",
      code: "ignored_parameter",
      ignoredParameters: ["request.temperature", "request.cwd"]
    }, "unexpected OpenAI request parameters were ignored");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/tmp");
  });
});
