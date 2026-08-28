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

export interface AgentRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: AgentMessage[];
  readonly reasoning?: AgentReasoningOptions;
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
