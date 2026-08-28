import type { FastifyReply } from "fastify";
import type { AgentRequest } from "../../core/types.js";
import { SseWriter } from "../../transport/http/sse.js";
import type { ProtocolRequestContext, ProtocolRouteContext } from "../protocol.js";
import { encodeOpenAIError } from "./errorCodec.js";
import { externalId } from "./responseCodec.js";
import { chatChunk, responsesEvent } from "./streamCodec.js";

export async function streamChatCompletion(
  route: ProtocolRouteContext,
  request: AgentRequest,
  includeUsage: boolean,
  reply: FastifyReply,
  execution: ProtocolRequestContext
): Promise<void> {
  const writer = new SseWriter(reply, route.heartbeatIntervalMs);
  const created = Math.floor(Date.now() / 1000);
  let streamId = externalId("chatcmpl", `a2a_${crypto.randomUUID()}`);
  let model = request.model;
  try {
    for await (const event of route.runner.stream(request, { signal: execution.signal })) {
      if (event.type === "response.start") {
        streamId = externalId("chatcmpl", event.id);
        model = event.model;
        await writer.write(chatChunk({ id: streamId, model, created, delta: { role: "assistant", content: "" } }));
      } else if (event.type === "text.delta") {
        await writer.write(chatChunk({ id: streamId, model, created, delta: { content: event.delta } }));
      } else if (event.type === "response.complete") {
        await writer.write(chatChunk({ id: streamId, model, created, delta: {}, finishReason: event.finishReason }));
      } else {
        await writer.write({ event: "error", data: JSON.stringify(encodeOpenAIError(event.error).body) });
      }
    }
    if (includeUsage) {
      await writer.write(chatChunk({
        id: streamId,
        model,
        created,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    }
    await writer.done();
  } finally {
    execution.complete();
    writer.end();
  }
}

export async function streamResponses(
  route: ProtocolRouteContext,
  request: AgentRequest,
  reply: FastifyReply,
  execution: ProtocolRequestContext
): Promise<void> {
  const writer = new SseWriter(reply, route.heartbeatIntervalMs);
  let responseId = externalId("resp", `a2a_${crypto.randomUUID()}`);
  let itemId = externalId("msg", responseId);
  let model = request.model;
  let text = "";
  try {
    for await (const event of route.runner.stream(request, { signal: execution.signal })) {
      if (event.type === "response.start") {
        responseId = externalId("resp", event.id);
        itemId = externalId("msg", event.id);
        model = event.model;
        await writer.write(responsesEvent("response.created", {
          response: baseStreamingResponse(responseId, model, "in_progress", [])
        }));
        await writer.write(responsesEvent("response.output_item.added", {
          response_id: responseId,
          output_index: 0,
          item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] }
        }));
        await writer.write(responsesEvent("response.content_part.added", {
          response_id: responseId,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] }
        }));
      } else if (event.type === "text.delta") {
        text += event.delta;
        await writer.write(responsesEvent("response.output_text.delta", {
          response_id: responseId,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: event.delta
        }));
      } else if (event.type === "response.complete") {
        const output = [{
          id: itemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }]
        }];
        await writer.write(responsesEvent("response.output_text.done", {
          response_id: responseId,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text
        }));
        await writer.write(responsesEvent("response.output_item.done", {
          response_id: responseId,
          output_index: 0,
          item: output[0]
        }));
        await writer.write(responsesEvent("response.completed", {
          response: baseStreamingResponse(responseId, model, "completed", output)
        }));
      } else {
        await writer.write(responsesEvent("error", encodeOpenAIError(event.error).body));
      }
    }
    await writer.done();
  } finally {
    execution.complete();
    writer.end();
  }
}

function baseStreamingResponse(id: string, model: string, status: string, output: unknown[]): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    usage: null
  };
}
