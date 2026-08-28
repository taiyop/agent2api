import type { ProtocolRouteContext } from "../protocol.js";
import { sendOpenAIError } from "./errorCodec.js";
import { decodeResponsesRequest } from "./requestCodec.js";
import { encodeResponsesResponse } from "./responseCodec.js";
import { streamResponses } from "./streaming.js";
import { logOpenAIWarnings } from "./warnings.js";

export function registerResponsesRoute(context: ProtocolRouteContext): void {
  context.server.post(`${context.prefix}/responses`, async (request, reply) => {
    const execution = context.createRequestContext(request, reply);
    try {
      const decoded = decodeResponsesRequest(request.body, String(request.id));
      logOpenAIWarnings(request, decoded.warnings);
      if (decoded.stream) {
        await streamResponses(context, decoded.request, reply, execution);
        return reply;
      }
      const response = await context.runner.execute(decoded.request, { signal: execution.signal });
      execution.complete();
      return encodeResponsesResponse(response);
    } catch (error) {
      execution.complete();
      sendOpenAIError(reply, error);
      return reply;
    }
  });
}
