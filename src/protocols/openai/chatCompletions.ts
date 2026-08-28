import type { ProtocolRouteContext } from "../protocol.js";
import { sendOpenAIError } from "./errorCodec.js";
import { decodeChatCompletionRequest } from "./requestCodec.js";
import { encodeChatCompletionResponse } from "./responseCodec.js";
import { streamChatCompletion } from "./streaming.js";
import { logOpenAIWarnings } from "./warnings.js";

export function registerChatCompletionsRoute(context: ProtocolRouteContext): void {
  context.server.post(`${context.prefix}/chat/completions`, async (request, reply) => {
    const execution = context.createRequestContext(request, reply);
    try {
      const decoded = decodeChatCompletionRequest(request.body, String(request.id));
      logOpenAIWarnings(request, decoded.warnings);
      if (decoded.stream) {
        await streamChatCompletion(context, decoded.request, decoded.includeUsage, reply, execution);
        return reply;
      }
      const response = await context.runner.execute(decoded.request, { signal: execution.signal });
      execution.complete();
      return encodeChatCompletionResponse(response);
    } catch (error) {
      execution.complete();
      sendOpenAIError(reply, error);
      return reply;
    }
  });
}
