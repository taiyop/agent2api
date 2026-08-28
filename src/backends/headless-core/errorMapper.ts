import { Agent2APIError } from "../../core/errors.js";

const HEADLESS_FAILURE_KINDS = new Set(["network", "rate_limit", "agent_stopped", "unknown"]);

export function mapHeadlessCoreError(error: unknown, signal: AbortSignal): Agent2APIError {
  if (signal.aborted) {
    return new Agent2APIError({
      code: "cancelled",
      message: "Agent execution was cancelled",
      retryable: false,
      cause: error
    });
  }

  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const kind = findFailureKind(error);

  if (kind === "rate_limit" || lower.includes("rate limit") || lower.includes("too many requests")) {
    return new Agent2APIError({ code: "rate_limit", message: "Agent CLI rate limit reached", cause: error });
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new Agent2APIError({ code: "timeout", message: "Agent CLI execution timed out", cause: error });
  }
  if (isAuthenticationFailure(lower)) {
    return new Agent2APIError({
      code: "backend_unavailable",
      message: "Agent CLI is unavailable. Check that the target CLI is installed and already authenticated.",
      cause: error
    });
  }
  if (kind === "network") {
    return new Agent2APIError({
      code: "backend_unavailable",
      message: "Agent CLI network connection failed",
      cause: error
    });
  }
  return new Agent2APIError({
    code: "backend_unavailable",
    message: "Agent CLI execution failed. Check that the target CLI is installed and already authenticated.",
    cause: error
  });
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value) return String(value.message);
  return String(value);
}

function findFailureKind(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.kind === "string" && HEADLESS_FAILURE_KINDS.has(record.kind)) return record.kind;
  for (const key of ["error", "cause"] as const) {
    const found = findFailureKind(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isAuthenticationFailure(message: string): boolean {
  return ["not authenticated", "unauthenticated", "login required", "not logged in", "credential"].some((part) =>
    message.includes(part)
  );
}
