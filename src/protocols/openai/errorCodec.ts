import type { FastifyReply } from "fastify";
import { normalizeError } from "../../core/errors.js";

export function sendOpenAIError(reply: FastifyReply, value: unknown): void {
  const encoded = encodeOpenAIError(value);
  void reply.status(encoded.statusCode).send(encoded.body);
}

export function encodeOpenAIError(value: unknown): { statusCode: number; body: Record<string, unknown> } {
  const error = normalizeError(value);
  const type = error.code === "invalid_request" || error.code === "unsupported_feature"
    ? "invalid_request_error"
    : error.code === "model_not_found"
      ? "invalid_request_error"
      : "server_error";
  return {
    statusCode: error.statusCode === 499 ? 400 : error.statusCode,
    body: { error: {
      message: error.message,
      type,
      param: error.param ?? null,
      code: error.code
    } }
  };
}
