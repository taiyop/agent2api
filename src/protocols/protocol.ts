import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModelRegistry } from "../core/modelRegistry.js";
import type { AgentRunner } from "../core/runner.js";

export interface ProtocolRequestContext {
  readonly signal: AbortSignal;
  complete(): void;
}

export interface ProtocolRouteContext {
  readonly server: FastifyInstance;
  readonly prefix: string;
  readonly runner: AgentRunner;
  readonly models: ModelRegistry;
  readonly heartbeatIntervalMs?: number;
  createRequestContext(request: FastifyRequest, reply: FastifyReply): ProtocolRequestContext;
}

export interface ProtocolAdapter {
  readonly id: string;
  registerRoutes(context: ProtocolRouteContext): void;
}
