import { Agent2APIError } from "../../core/errors.js";
import type { AgentMessage, AgentReasoningOptions, AgentRole, AgentRequest } from "../../core/types.js";
import type {
  DecodedOpenAIRequest,
  OpenAIChatRequest,
  OpenAIMessageInput,
  OpenAIRequestWarning,
  OpenAIResponsesRequest
} from "./types.js";

const CHAT_UNSUPPORTED_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "modalities",
  "audio",
  "response_format"
] as const;

const RESPONSES_UNSUPPORTED_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "previous_response_id",
  "include"
] as const;

export function decodeChatCompletionRequest(body: unknown, requestId: string): DecodedOpenAIRequest {
  const input = requireObject(body) as OpenAIChatRequest;
  const warnings: OpenAIRequestWarning[] = [];
  rejectPresentFields(input, CHAT_UNSUPPORTED_FIELDS);
  collectUnknownFields(input, ["model", "messages", "stream", "stream_options", "reasoning", "metadata"], "request", warnings);
  const model = requireString(input.model, "model");
  if (!Array.isArray(input.messages)) invalid("messages must be an array", "messages");
  const messages = input.messages.map((message, index) => decodeMessage(message, `messages.${index}`, warnings));
  const stream = optionalBoolean(input.stream, "stream") ?? false;
  const includeUsage = decodeStreamOptions(input.stream_options, warnings);
  return {
    request: createCanonicalRequest(requestId, model, messages, input.reasoning, input.metadata, warnings),
    stream,
    includeUsage,
    warnings
  };
}

export function decodeResponsesRequest(body: unknown, requestId: string): DecodedOpenAIRequest {
  const input = requireObject(body) as OpenAIResponsesRequest;
  const warnings: OpenAIRequestWarning[] = [];
  rejectPresentFields(input, RESPONSES_UNSUPPORTED_FIELDS);
  collectUnknownFields(input, ["model", "input", "instructions", "stream", "reasoning", "metadata", "store"], "request", warnings);
  if (input.store !== undefined && input.store !== false && input.store !== null) {
    unsupported("store", "Persistent responses are not supported");
  }
  const model = requireString(input.model, "model");
  const messages: AgentMessage[] = [];
  if (input.instructions !== undefined) {
    messages.push({
      role: "developer",
      content: [{ type: "text", text: requireString(input.instructions, "instructions") }]
    });
  }
  if (typeof input.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input.input }] });
  } else if (Array.isArray(input.input)) {
    messages.push(...input.input.map((message, index) => decodeMessage(message, `input.${index}`, warnings)));
  } else {
    invalid("input must be a string or message array", "input");
  }
  return {
    request: createCanonicalRequest(requestId, model, messages, input.reasoning, input.metadata, warnings),
    stream: optionalBoolean(input.stream, "stream") ?? false,
    includeUsage: false,
    warnings
  };
}

function createCanonicalRequest(
  requestId: string,
  model: string,
  messages: AgentMessage[],
  reasoningValue: unknown,
  metadataValue: unknown,
  warnings: OpenAIRequestWarning[]
): AgentRequest {
  const reasoning = decodeReasoning(reasoningValue, warnings);
  const metadata = decodeMetadata(metadataValue);
  return {
    requestId,
    model,
    messages,
    ...(reasoning ? { reasoning } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function decodeMessage(value: unknown, path: string, warnings: OpenAIRequestWarning[]): AgentMessage {
  const message = requireObject(value) as unknown as OpenAIMessageInput & Record<string, unknown>;
  if (message.type !== undefined && message.type !== "message") {
    unsupported(path, `Input item type '${String(message.type)}' is not supported`);
  }
  if (message.tool_calls !== undefined || message.function_call !== undefined) {
    unsupported(path, "Tool calls are not supported");
  }
  if (message.refusal !== undefined) {
    unsupported(path, "Assistant refusal content is not supported");
  }
  collectUnknownFields(message, ["type", "role", "content"], path, warnings);
  const role = decodeRole(message.role, path);
  return { role, content: decodeContent(message.content, `${path}.content`, warnings) };
}

function decodeContent(value: unknown, path: string, warnings: OpenAIRequestWarning[]): AgentMessage["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value) || value.length === 0) invalid("content must be text or a non-empty text content array", path);
  return value.map((part, index) => {
    const item = requireObject(part);
    const type = item.type;
    if (type !== "text" && type !== "input_text" && type !== "output_text") {
      unsupported(`${path}.${index}`, `Content type '${String(type)}' is not supported`);
    }
    collectUnknownFields(item, ["type", "text"], `${path}.${index}`, warnings);
    return { type: "text" as const, text: requireString(item.text, `${path}.${index}.text`) };
  });
}

function decodeRole(value: unknown, path: string): AgentRole {
  if (value === "tool") unsupported(path, "Tool result messages are not supported");
  if (value === "system" || value === "developer" || value === "user" || value === "assistant") return value;
  invalid("role must be system, developer, user, or assistant", `${path}.role`);
}

function decodeReasoning(value: unknown, warnings: OpenAIRequestWarning[]): AgentReasoningOptions | undefined {
  if (value === undefined || value === null) return undefined;
  const reasoning = requireObject(value);
  collectUnknownFields(reasoning, ["effort"], "reasoning", warnings);
  if (reasoning.effort === undefined || reasoning.effort === null) return {};
  return { effort: requireString(reasoning.effort, "reasoning.effort") };
}

function decodeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return requireObject(value);
}

function decodeStreamOptions(value: unknown, warnings: OpenAIRequestWarning[]): boolean {
  if (value === undefined || value === null) return false;
  const options = requireObject(value);
  collectUnknownFields(options, ["include_usage"], "stream_options", warnings);
  return optionalBoolean(options.include_usage, "stream_options.include_usage") ?? false;
}

function rejectPresentFields(input: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (input[field] !== undefined) unsupported(field, `Feature '${field}' is not supported`);
  }
}

function collectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  warnings: OpenAIRequestWarning[]
): void {
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) {
      const param = `${path}.${field}`;
      warnings.push({
        code: "ignored_parameter",
        param,
        message: `Unexpected parameter '${param}' was ignored`
      });
    }
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request body must be a JSON object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${param} must be a non-empty string`, param);
  return value;
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`${param} must be a boolean`, param);
  return value;
}

function invalid(message: string, param?: string): never {
  throw new Agent2APIError({ code: "invalid_request", message, ...(param ? { param } : {}) });
}

function unsupported(param: string, message: string): never {
  throw new Agent2APIError({ code: "unsupported_feature", message, param });
}
