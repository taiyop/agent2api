export type Agent2APIErrorCode =
  | "invalid_request"
  | "model_not_found"
  | "unsupported_feature"
  | "backend_unavailable"
  | "timeout"
  | "cancelled"
  | "rate_limit"
  | "internal_error";

export interface Agent2APIErrorOptions {
  readonly code: Agent2APIErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly param?: string;
  readonly cause?: unknown;
}

export class Agent2APIError extends Error {
  readonly code: Agent2APIErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly param?: string;

  constructor(options: Agent2APIErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "Agent2APIError";
    this.code = options.code;
    this.statusCode = options.statusCode ?? defaultStatusCode(options.code);
    this.retryable = options.retryable ?? defaultRetryable(options.code);
    if (options.param !== undefined) this.param = options.param;
  }
}

export function defaultStatusCode(code: Agent2APIErrorCode): number {
  switch (code) {
    case "invalid_request":
    case "unsupported_feature":
      return 400;
    case "model_not_found":
      return 404;
    case "timeout":
      return 504;
    case "cancelled":
      return 499;
    case "rate_limit":
      return 429;
    case "backend_unavailable":
      return 503;
    case "internal_error":
      return 500;
  }
}

function defaultRetryable(code: Agent2APIErrorCode): boolean {
  return code === "backend_unavailable" || code === "timeout" || code === "rate_limit";
}

export function normalizeError(error: unknown): Agent2APIError {
  if (error instanceof Agent2APIError) return error;
  return new Agent2APIError({
    code: "internal_error",
    message: "Internal Agent2API error",
    cause: error
  });
}
