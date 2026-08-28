import {
  BackendError,
  type BackendCapabilities,
  type BackendErrorCode,
  type ExternalApiBackend,
  type InvocationContext,
  type InvocationEvent,
  type InvocationRequest,
  type InvocationResponse,
  type Message,
  type ModelInfo
} from "llm-mimic-surface";
import type { Agent2APIErrorCode } from "../../core/errors.js";
import { normalizeError } from "../../core/errors.js";
import type { ModelRegistry } from "../../core/modelRegistry.js";
import type { AgentRunner } from "../../core/runner.js";
import type { AgentMessage, AgentRequest } from "../../core/types.js";

const CAPABILITIES: BackendCapabilities = {
  streaming: true,
  tools: false,
  providerTools: false,
  reasoning: true,
  structuredOutput: false,
  citations: false,
  input: {
    text: true,
    image: false,
    file: false
  }
};

export interface Agent2APISurfaceBackendOptions {
  readonly runner: AgentRunner;
  readonly models: ModelRegistry;
}

/** Adapts LLMMimicSurface's protocol-neutral SPI to the Agent2API core. */
export class Agent2APISurfaceBackend implements ExternalApiBackend {
  constructor(private readonly options: Agent2APISurfaceBackendOptions) {}

  capabilities(): BackendCapabilities {
    return CAPABILITIES;
  }

  async listModels(_context: InvocationContext): Promise<ModelInfo[]> {
    return this.options.models.list().map((model) => ({
      id: model.id,
      ownedBy: model.ownedBy ?? "agent2api"
    }));
  }

  async invoke(request: InvocationRequest, context: InvocationContext): Promise<InvocationResponse> {
    try {
      const response = await this.options.runner.execute(toAgentRequest(request, context), {
        signal: context.signal
      });
      return {
        id: response.id,
        model: response.model,
        message: {
          role: "assistant",
          content: response.content.map((part) => ({ type: "text", text: part.text }))
        },
        finishReason: response.finishReason
      };
    } catch (error) {
      throw toSurfaceError(error);
    }
  }

  async *stream(request: InvocationRequest, context: InvocationContext): AsyncIterable<InvocationEvent> {
    const agentRequest = toAgentRequest(request, context);
    for await (const event of this.options.runner.stream(agentRequest, { signal: context.signal })) {
      switch (event.type) {
        case "response.start":
          yield { type: "response.start", id: event.id, model: event.model };
          break;
        case "text.delta":
          yield { type: "text.delta", delta: event.delta };
          break;
        case "response.complete":
          yield { type: "response.end", finishReason: event.finishReason };
          break;
        case "response.error":
          throw toSurfaceError(event.error);
      }
    }
  }
}

function toAgentRequest(request: InvocationRequest, context: InvocationContext): AgentRequest {
  const messages: AgentMessage[] = [];
  if (request.instructions?.trim()) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: request.instructions.trim() }]
    });
  }
  messages.push(...request.messages.map(toAgentMessage));
  return {
    requestId: context.requestId,
    model: request.model,
    messages,
    ...(request.reasoning?.effort !== undefined
      ? { reasoning: { effort: request.reasoning.effort } }
      : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(request.extensions ? { extensions: request.extensions } : {})
  };
}

function toAgentMessage(message: Message): AgentMessage {
  if (message.role !== "system" && message.role !== "developer" && message.role !== "user" && message.role !== "assistant") {
    throw new BackendError({
      code: "unsupported_feature",
      message: `Message role '${message.role}' is not supported by Agent2API`,
      param: "messages"
    });
  }
  return {
    role: message.role,
    content: message.content.map((part) => {
      if (part.type !== "text") {
        throw new BackendError({
          code: "unsupported_feature",
          message: `Message content type '${part.type}' is not supported by Agent2API`,
          param: "messages"
        });
      }
      return { type: "text", text: part.text };
    })
  };
}

function toSurfaceError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  const normalized = normalizeError(error);
  return new BackendError({
    code: mapErrorCode(normalized.code),
    message: normalized.message,
    status: normalized.statusCode,
    ...(normalized.param ? { param: normalized.param } : {}),
    cause: error
  });
}

function mapErrorCode(code: Agent2APIErrorCode): BackendErrorCode {
  return code === "cancelled" ? "aborted" : code;
}
