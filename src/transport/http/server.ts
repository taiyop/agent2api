import Fastify, { type FastifyInstance } from "fastify";
import type { AgentBackend } from "../../backends/backend.js";
import { HeadlessCoreBackend } from "../../backends/headless-core/backend.js";
import { resolveHeadlessCoreModel } from "../../backends/headless-core/modelMapper.js";
import type { Agent2APIConfig } from "../../config/schema.js";
import { StaticModelRegistry } from "../../core/modelRegistry.js";
import { LabeledPromptRenderer } from "../../core/promptRenderer.js";
import { AgentRunner } from "../../core/runner.js";
import { OpenAIProtocolAdapter } from "../../protocols/openai/index.js";
import { registerBearerAuth } from "./auth.js";
import { createHttpRequestContext } from "./requestContext.js";

export interface CreateServerOptions {
  readonly backends?: AgentBackend[];
}

export function createServer(config: Agent2APIConfig, options: CreateServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: config.server.logging });
  const models = new StaticModelRegistry({ ...config.models, resolveUnknown: resolveHeadlessCoreModel });
  const backends = options.backends ?? [new HeadlessCoreBackend(config.backends["headless-core"])];
  const runner = new AgentRunner({ models, backends, promptRenderer: new LabeledPromptRenderer() });

  server.get("/health", async () => ({ status: "ok" }));
  if (config.server.auth) registerBearerAuth(server, config.server.auth.bearerToken);

  for (const entry of config.interfaces) {
    if (entry.type === "openai") {
      new OpenAIProtocolAdapter().registerRoutes({
        server,
        prefix: entry.prefix,
        runner,
        models,
        heartbeatIntervalMs: config.server.heartbeatIntervalMs,
        createRequestContext: createHttpRequestContext
      });
    }
  }

  server.addHook("onResponse", async (request, reply) => {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const requestedModel = typeof body.model === "string" ? body.model : null;
    let backend: string | null = null;
    let agent: string | null = null;
    let model: string | null = requestedModel;
    if (requestedModel) {
      try {
        const resolvedModel = models.get(requestedModel);
        model = resolvedModel.id;
        backend = resolvedModel.target.backend;
        agent = resolvedModel.target.agent;
      } catch {
        // A failed resolution is represented by null target fields, not request content.
      }
    }
    request.log.info({
      requestId: String(request.id),
      protocol: request.url.includes("/v1/") ? "openai" : "http",
      model,
      backend,
      agent,
      duration: reply.elapsedTime,
      status: reply.statusCode
    }, "agent2api request");
  });

  return server;
}

export async function startServer(config: Agent2APIConfig, options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const server = createServer(config, options);
  await server.listen({ host: config.server.host, port: config.server.port });
  return server;
}
