import { describe, expect, it } from "vitest";
import { encodeChatCompletionResponse, encodeResponsesResponse } from "../../../src/protocols/openai/responseCodec.js";

const response = {
  id: "a2a_123",
  model: "codex/default",
  content: [{ type: "text" as const, text: "Hello." }],
  finishReason: "stop" as const
};

describe("OpenAI response codecs", () => {
  it("encodes a chat completion", () => {
    expect(encodeChatCompletionResponse(response, 123)).toMatchObject({
      id: "chatcmpl_123",
      object: "chat.completion",
      created: 123,
      model: "codex/default",
      choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }]
    });
  });

  it("encodes a Responses response", () => {
    expect(encodeResponsesResponse(response, 123)).toMatchObject({
      id: "resp_123",
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello." }] }]
    });
  });
});
