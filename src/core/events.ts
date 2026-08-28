import type { Agent2APIError } from "./errors.js";

export type AgentEvent =
  | { readonly type: "response.start"; readonly id: string; readonly model: string }
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "response.complete"; readonly finishReason: "stop" | "length" | "cancelled" | "error" }
  | { readonly type: "response.error"; readonly error: Agent2APIError };

export type AgentExecutionProgress =
  | { readonly type: "execution.state"; readonly state: string; readonly message?: string }
  | { readonly type: "execution.output"; readonly stream: "stdout" | "stderr" | "unknown" };
