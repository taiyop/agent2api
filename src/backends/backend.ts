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

export interface AgentSessionSpec {
  readonly requestId: string;
  readonly modelId: string;
  readonly target: AgentModelTarget;
  readonly reasoning?: AgentReasoningOptions;
}

/**
 * A conversation the Agent keeps open between turns. Each turn sees the earlier ones, so a later
 * turn only sends what is new. Turns run one at a time.
 */
export interface AgentSession {
  /** False once the session failed or was closed; it must not be used again. */
  readonly alive: boolean;
  run(prompt: string, context: AgentExecutionContext): Promise<AgentExecutionResult>;
  close(): Promise<void>;
}

export interface AgentBackend {
  readonly id: string;
  execute(request: AgentExecutionRequest, context: AgentExecutionContext): Promise<AgentExecutionResult>;
  capabilities(): AgentCapabilities;
  /**
   * Opens a conversation that keeps its history between turns. Returns undefined when this target
   * cannot keep one; the caller then runs each request with `execute`.
   */
  openSession?(spec: AgentSessionSpec): Promise<AgentSession | undefined>;
  /** Releases resources held by the backend when the server shuts down. */
  close?(): void | Promise<void>;
}
