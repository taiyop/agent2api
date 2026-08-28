import type { ProtocolAdapter, ProtocolRouteContext } from "../protocol.js";
import { registerChatCompletionsRoute } from "./chatCompletions.js";
import { encodeModels } from "./models.js";
import { registerResponsesRoute } from "./responses.js";
import { Agent2APIError } from "../../core/errors.js";
import { sendOpenAIError } from "./errorCodec.js";

export class OpenAIProtocolAdapter implements ProtocolAdapter {
  readonly id = "openai";

  registerRoutes(context: ProtocolRouteContext): void {
    context.server.get(`${context.prefix}/models`, async () => encodeModels(context.models.list()));
    registerChatCompletionsRoute(context);
    registerResponsesRoute(context);
    for (const path of ["/embeddings", "/images/generations", "/audio/speech", "/audio/transcriptions"]) {
      context.server.post(`${context.prefix}${path}`, async (_request, reply) => {
        sendOpenAIError(reply, new Agent2APIError({
          code: "unsupported_feature",
          message: `Endpoint '${path}' is not supported by Agent2API`,
          param: path
        }));
        return reply;
      });
    }
  }
}
