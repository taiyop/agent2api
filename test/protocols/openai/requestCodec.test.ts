import { describe, expect, it } from "vitest";
import { decodeChatCompletionRequest, decodeResponsesRequest } from "../../../src/protocols/openai/requestCodec.js";

describe("OpenAI request codecs", () => {
  it("converts a chat request to canonical IR", () => {
    const decoded = decodeChatCompletionRequest(
      {
        model: "codex/default",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: [{ type: "text", text: "Hello" }] }
        ],
        reasoning: { effort: "high" }
      },
      "req_chat"
    );
    expect(decoded.request).toEqual({
      requestId: "req_chat",
      model: "codex/default",
      messages: [
        { role: "system", content: [{ type: "text", text: "You are helpful." }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] }
      ],
      reasoning: { effort: "high" }
    });
  });

  it("converts Responses string and message-array input to canonical IR", () => {
    expect(decodeResponsesRequest({ model: "codex/default", input: "Hello" }, "req_1").request.messages)
      .toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);

    expect(
      decodeResponsesRequest(
        {
          model: "codex/default",
          instructions: "Be concise.",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }]
        },
        "req_2"
      ).request.messages
    ).toEqual([
      { role: "developer", content: [{ type: "text", text: "Be concise." }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] }
    ]);
  });

  it.each([
    [{ model: "codex/default", messages: [{ role: "user", content: "x" }], tools: [] }, "tools"],
    [
      { model: "codex/default", messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }] },
      "image"
    ],
    [{ model: "codex/default", input: "x", previous_response_id: "resp_1" }, "previous_response_id"]
  ])("rejects unsupported features: %s", (body, expected) => {
    const decode = "messages" in body ? decodeChatCompletionRequest : decodeResponsesRequest;
    expect(() => decode(body, "req_bad")).toThrowError(expect.objectContaining({ code: "unsupported_feature" }));
    expect(() => decode(body, "req_bad")).toThrowError(new RegExp(expected));
  });

  it("collects unexpected parameters as warnings and ignores their values", () => {
    const decoded = decodeChatCompletionRequest({
      model: "codex/default",
      messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: "private" }], name: "client" }],
      temperature: 0.2,
      cwd: "/tmp",
      reasoning: { effort: "high", summary: "auto" }
    }, "req_warn");

    expect(decoded.warnings.map((warning) => warning.param)).toEqual([
      "request.temperature",
      "request.cwd",
      "messages.0.name",
      "messages.0.content.0.cache_control",
      "reasoning.summary"
    ]);
    expect(decoded.request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "x" }] }]);
    expect(decoded.request.metadata).toBeUndefined();
  });
});
