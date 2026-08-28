import type { FastifyRequest } from "fastify";
import type { OpenAIRequestWarning } from "./types.js";

export function logOpenAIWarnings(request: FastifyRequest, warnings: OpenAIRequestWarning[]): void {
  if (warnings.length === 0) return;
  request.log.warn({
    requestId: String(request.id),
    protocol: "openai",
    code: "ignored_parameter",
    ignoredParameters: warnings.map((warning) => warning.param)
  }, "unexpected OpenAI request parameters were ignored");
}
