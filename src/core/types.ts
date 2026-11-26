export type AgentRole = "system" | "developer" | "user" | "assistant";

export interface AgentTextContent {
  readonly type: "text";
  readonly text: string;
}

/** Extend this union with image/audio/file/tool variants when they are supported. */
export type AgentContent = AgentTextContent;

export interface AgentMessage {
  readonly role: AgentRole;
  readonly content: AgentContent[];
}

export interface AgentReasoningOptions {
  readonly effort?: string;
}

/**
 * - `auto`: continue a kept conversation when the history matches one, otherwise start a new one.
 * - `new`: always start a new conversation.
 */
export type ConversationMode = "auto" | "new";

export interface AgentConversationOptions {
  /** Continues from this earlier response (Responses API `previous_response_id`). */
  readonly previousResponseId?: string;
  readonly mode?: ConversationMode;
  /** False keeps neither the conversation nor the response (Responses API `store: false`). */
  readonly store?: boolean;
  /** Remembers the response so a later `previousResponseId` can name it. */
  readonly recordResponse?: boolean;
}

export interface AgentRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: AgentMessage[];
  readonly reasoning?: AgentReasoningOptions;
  readonly conversation?: AgentConversationOptions;
  readonly metadata?: Record<string, unknown>;
  readonly extensions?: Record<string, unknown>;
}

export type AgentFinishReason = "stop" | "length" | "cancelled" | "error";

export interface AgentResponse {
  readonly id: string;
  readonly model: string;
  readonly content: AgentContent[];
  readonly finishReason: AgentFinishReason;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentModelTarget {
  readonly backend: string;
  readonly agent: string;
  readonly model: string;
}

export interface AgentModel {
  readonly id: string;
  readonly target: AgentModelTarget;
  readonly defaultReasoning?: AgentReasoningOptions;
  readonly ownedBy?: string;
  readonly capabilities?: Partial<AgentCapabilities>;
}

export interface AgentCapabilities {
  readonly textInput: boolean;
  readonly textOutput: boolean;
  readonly streaming: boolean;
  readonly reasoningEffort: boolean;
  readonly externalTools: boolean;
  readonly imageInput: boolean;
  readonly audioInput: boolean;
  readonly fileInput: boolean;
}
