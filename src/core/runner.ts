import type { AgentBackend, AgentExecutionContext } from "../backends/backend.js";
import { Agent2APIError, normalizeError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import { textContent, validateMessages } from "./messages.js";
import type { ModelRegistry } from "./modelRegistry.js";
import type { PromptRenderer } from "./promptRenderer.js";
import type { AgentRequest, AgentResponse } from "./types.js";

export interface AgentRunnerOptions {
  readonly models: ModelRegistry;
  readonly backends: Iterable<AgentBackend>;
  readonly promptRenderer: PromptRenderer;
}

export class AgentRunner {
  readonly #backends: Map<string, AgentBackend>;

  constructor(private readonly options: AgentRunnerOptions) {
    this.#backends = new Map([...options.backends].map((backend) => [backend.id, backend]));
  }

  async execute(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    validateMessages(request.messages);
    const model = this.options.models.get(request.model);
    const backend = this.#backends.get(model.target.backend);
    if (!backend) {
      throw new Agent2APIError({
        code: "backend_unavailable",
        message: `Backend '${model.target.backend}' is not configured`,
        retryable: false
      });
    }
    const capabilities = { ...backend.capabilities(), ...(model.capabilities ?? {}) };
    const reasoning = request.reasoning?.effort !== undefined
      ? request.reasoning
      : model.defaultReasoning ?? request.reasoning;
    if (reasoning?.effort && !capabilities.reasoningEffort) {
      throw new Agent2APIError({
        code: "unsupported_feature",
        message: `Model '${model.id}' does not support reasoning effort`,
        param: "reasoning.effort"
      });
    }
    const result = await backend.execute(
      {
        requestId: request.requestId,
        modelId: model.id,
        target: model.target,
        prompt: this.options.promptRenderer.render(request.messages),
        ...(reasoning ? { reasoning } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {})
      },
      context
    );
    return {
      id: `a2a_${crypto.randomUUID()}`,
      model: model.id,
      content: [textContent(result.output)],
      finishReason: result.finishReason ?? "stop",
      ...(result.metadata ? { metadata: result.metadata } : {})
    };
  }

  async *stream(request: AgentRequest, context: AgentExecutionContext): AsyncGenerator<AgentEvent> {
    const id = `a2a_${crypto.randomUUID()}`;
    try {
      yield { type: "response.start", id, model: this.options.models.get(request.model).id };
      const response = await this.execute(request, context);
      for (const content of response.content) {
        yield { type: "text.delta", delta: content.text };
      }
      yield { type: "response.complete", finishReason: response.finishReason };
    } catch (error) {
      yield { type: "response.error", error: normalizeError(error) };
    }
  }
}
