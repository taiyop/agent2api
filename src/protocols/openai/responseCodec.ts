import { contentText } from "../../core/messages.js";
import type { AgentResponse } from "../../core/types.js";

export function encodeChatCompletionResponse(response: AgentResponse, created = unixTime()): Record<string, unknown> {
  return {
    id: externalId("chatcmpl", response.id),
    object: "chat.completion",
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: contentText(response.content), refusal: null },
        logprobs: null,
        finish_reason: response.finishReason
      }
    ],
    usage: null
  };
}

export function encodeResponsesResponse(response: AgentResponse, createdAt = unixTime()): Record<string, unknown> {
  const id = externalId("resp", response.id);
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: response.model,
    output: [
      {
        id: externalId("msg", response.id),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: contentText(response.content), annotations: [] }]
      }
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null,
    metadata: response.metadata ?? {}
  };
}

export function externalId(prefix: string, id: string): string {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id.replace(/^[^_]+_/, "")}`;
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}
