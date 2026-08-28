import type { AgentExecutionProgress } from "../core/events.js";
import type { AgentCapabilities, AgentModelTarget, AgentReasoningOptions } from "../core/types.js";

export interface AgentExecutionRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly target: AgentModelTarget;
  readonly prompt: string;
  readonly reasoning?: AgentReasoningOptions;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentExecutionContext {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (event: AgentExecutionProgress) => void;
}

export interface AgentExecutionResult {
  readonly output: string;
  readonly finishReason?: "stop" | "length" | "cancelled" | "error";
  readonly metadata?: Record<string, unknown>;
}

export interface AgentBackend {
  readonly id: string;
  execute(request: AgentExecutionRequest, context: AgentExecutionContext): Promise<AgentExecutionResult>;
  capabilities(): AgentCapabilities;
}
