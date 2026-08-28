export interface OpenAITextPart {
  readonly type: "text" | "input_text" | "output_text";
  readonly text: string;
}

export interface OpenAIMessageInput {
  readonly type?: "message";
  readonly role: string;
  readonly content: string | unknown[];
}

export interface OpenAIChatRequest {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
  readonly stream_options?: unknown;
  readonly reasoning?: unknown;
  readonly metadata?: unknown;
  readonly [key: string]: unknown;
}

export interface OpenAIResponsesRequest {
  readonly model?: unknown;
  readonly input?: unknown;
  readonly instructions?: unknown;
  readonly stream?: unknown;
  readonly reasoning?: unknown;
  readonly metadata?: unknown;
  readonly [key: string]: unknown;
}

export interface DecodedOpenAIRequest {
  readonly request: import("../../core/types.js").AgentRequest;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly warnings: OpenAIRequestWarning[];
}

export interface OpenAIRequestWarning {
  readonly code: "ignored_parameter";
  readonly param: string;
  readonly message: string;
}
