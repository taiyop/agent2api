import type { AgentBackend, AgentExecutionContext, AgentSession } from "../backends/backend.js";
import { conversationKey, type ConversationStore } from "./conversations.js";
import { Agent2APIError, normalizeError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import { contentText, textContent, validateMessages } from "./messages.js";
import type { ModelRegistry } from "./modelRegistry.js";
import type { PromptRenderer } from "./promptRenderer.js";
import type { AgentMessage, AgentModel, AgentReasoningOptions, AgentRequest, AgentResponse } from "./types.js";

export interface AgentRunnerOptions {
  readonly models: ModelRegistry;
  readonly backends: Iterable<AgentBackend>;
  readonly promptRenderer: PromptRenderer;
  /**
   * Keeps Agent conversations open between requests and remembers responses for
   * `previous_response_id`. Without it every request runs on its own and `previous_response_id`
   * is rejected.
   */
  readonly conversations?: ConversationStore;
  /** Whether conversations are kept open in the Agent. Defaults to true when `conversations` is set. */
  readonly keepSessions?: boolean;
}

interface Turn {
  /** The whole conversation this request continues, ending with its new messages. */
  readonly messages: AgentMessage[];
  /** The leading part of `messages` an earlier turn already sent, which a kept conversation may hold. */
  readonly sent: AgentMessage[];
}

export class AgentRunner {
  readonly #backends: Map<string, AgentBackend>;

  constructor(private readonly options: AgentRunnerOptions) {
    this.#backends = new Map([...options.backends].map((backend) => [backend.id, backend]));
  }

  async execute(request: AgentRequest, context: AgentExecutionContext, id = newResponseId()): Promise<AgentResponse> {
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

    const turn = this.#turn(request);
    const store = request.conversation?.store !== false;
    const effort = reasoning?.effort;
    const output = await this.#run(request, context, backend, model, reasoning, turn, store);
    const transcript: AgentMessage[] = [...turn.messages, { role: "assistant", content: [textContent(output.result.output)] }];
    if (output.session) {
      if (store) this.options.conversations?.keep(conversationKey(model.id, effort, transcript), output.session);
      else void output.session.close();
    }
    if (store && request.conversation?.recordResponse) this.options.conversations?.recordResponse(id, transcript);
    return {
      id,
      model: model.id,
      content: [textContent(output.result.output)],
      finishReason: output.result.finishReason ?? "stop",
      ...(output.result.metadata ? { metadata: output.result.metadata } : {})
    };
  }

  async *stream(request: AgentRequest, context: AgentExecutionContext): AsyncGenerator<AgentEvent> {
    const id = newResponseId();
    try {
      yield { type: "response.start", id, model: this.options.models.get(request.model).id };
      const response = await this.execute(request, context, id);
      for (const content of response.content) {
        yield { type: "text.delta", delta: content.text };
      }
      yield { type: "response.complete", finishReason: response.finishReason };
    } catch (error) {
      yield { type: "response.error", error: normalizeError(error) };
    }
  }

  /** Works out the whole conversation and the part of it an earlier turn already sent. */
  #turn(request: AgentRequest): Turn {
    const previousId = request.conversation?.previousResponseId;
    if (previousId !== undefined) {
      const history = this.options.conversations?.response(previousId);
      if (!history) {
        throw new Agent2APIError({
          code: "invalid_request",
          message: `Previous response with id '${previousId}' not found.`,
          param: "previous_response_id"
        });
      }
      return { messages: [...history, ...withoutRepeatedInstructions(history, request.messages)], sent: history };
    }
    let sent = request.messages.length;
    while (sent > 0 && request.messages[sent - 1]?.role !== "assistant") sent -= 1;
    return { messages: request.messages, sent: request.messages.slice(0, sent) };
  }

  async #run(
    request: AgentRequest,
    context: AgentExecutionContext,
    backend: AgentBackend,
    model: AgentModel,
    reasoning: AgentReasoningOptions | undefined,
    turn: Turn,
    store: boolean
  ): Promise<{ result: { output: string; finishReason?: AgentResponse["finishReason"]; metadata?: Record<string, unknown> }; session?: AgentSession }> {
    const render = (messages: AgentMessage[]) => this.options.promptRenderer.render(messages);
    const conversations = this.options.conversations;
    const keepSessions = conversations !== undefined && this.options.keepSessions !== false && backend.openSession !== undefined;

    if (keepSessions && store && request.conversation?.mode !== "new") {
      const added = turn.messages.slice(turn.sent.length);
      const kept = turn.sent.length > 0 && added.length > 0 && added.every((message) => message.role !== "assistant")
        ? conversations.take(conversationKey(model.id, reasoning?.effort, turn.sent))
        : undefined;
      if (kept) {
        try {
          return { result: await kept.run(render(added), context), session: kept };
        } catch (error) {
          void kept.close();
          // The kept conversation broke (its process exited, say). Start over with the full history.
          if (context.signal.aborted || normalizeError(error).code !== "backend_unavailable") throw error;
        }
      }
    }

    const prompt = render(turn.messages);
    const session = keepSessions
      ? await backend.openSession!({
          requestId: request.requestId,
          modelId: model.id,
          target: model.target,
          ...(reasoning ? { reasoning } : {})
        })
      : undefined;
    if (session) {
      try {
        return { result: await session.run(prompt, context), session };
      } catch (error) {
        void session.close();
        throw error;
      }
    }
    const result = await backend.execute(
      {
        requestId: request.requestId,
        modelId: model.id,
        target: model.target,
        prompt,
        ...(reasoning ? { reasoning } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {})
      },
      context
    );
    return { result };
  }
}

function newResponseId(): string {
  return `a2a_${crypto.randomUUID()}`;
}

/**
 * Clients usually send the same instructions with every request. When they match the ones already in
 * the history, they are not repeated; new instructions are added as a new system message.
 */
function withoutRepeatedInstructions(history: AgentMessage[], messages: AgentMessage[]): AgentMessage[] {
  const first = messages[0];
  if (!first || (first.role !== "system" && first.role !== "developer")) return messages;
  const text = contentText(first.content).trim();
  const repeated = history.some((message) => message.role === first.role && contentText(message.content).trim() === text);
  return repeated ? messages.slice(1) : messages;
}
