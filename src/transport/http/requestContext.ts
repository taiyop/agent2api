import type { FastifyReply, FastifyRequest } from "fastify";
import type { ProtocolRequestContext } from "../../protocols/protocol.js";

export function createHttpRequestContext(request: FastifyRequest, reply: FastifyReply): ProtocolRequestContext {
  const controller = new AbortController();
  let completed = false;
  const abort = () => {
    if (!completed && !controller.signal.aborted) controller.abort(new Error("HTTP client disconnected"));
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  return {
    signal: controller.signal,
    complete() {
      completed = true;
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  };
}
