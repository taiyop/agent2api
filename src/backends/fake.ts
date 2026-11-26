import { TEXT_AGENT_CAPABILITIES } from "../core/capabilities.js";
import type { AgentCapabilities } from "../core/types.js";
import type {
  AgentBackend,
  AgentExecutionContext,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentSession,
  AgentSessionSpec
} from "./backend.js";

export interface FakeBackendOptions {
  readonly output?: string;
  readonly execute?: (request: AgentExecutionRequest, context: AgentExecutionContext) => Promise<AgentExecutionResult>;
  /** Keeps conversations open like a persistent Agent. Each turn's reply comes from `reply`. */
  readonly sessions?: boolean;
  readonly reply?: (prompt: string, session: FakeAgentSession) => string | Promise<string>;
}

export class FakeAgentBackend implements AgentBackend {
  readonly id = "fake";
  readonly requests: AgentExecutionRequest[] = [];
  readonly contexts: AgentExecutionContext[] = [];
  readonly sessions: FakeAgentSession[] = [];
  readonly openSession?: (spec: AgentSessionSpec) => Promise<AgentSession | undefined>;

  constructor(private readonly options: FakeBackendOptions = {}) {
    if (options.sessions) {
      this.openSession = async (spec) => {
        const session = new FakeAgentSession(spec, (prompt, current) =>
          options.reply ? options.reply(prompt, current) : options.output ?? "Hello.");
        this.sessions.push(session);
        return session;
      };
    }
  }

  capabilities(): AgentCapabilities {
    return TEXT_AGENT_CAPABILITIES;
  }

  async execute(request: AgentExecutionRequest, context: AgentExecutionContext): Promise<AgentExecutionResult> {
    this.requests.push(request);
    this.contexts.push(context);
    if (this.options.execute) return this.options.execute(request, context);
    return { output: this.options.output ?? "Hello." };
  }
}

/** A conversation that records the prompt of every turn it ran. */
export class FakeAgentSession implements AgentSession {
  readonly prompts: string[] = [];
  #alive = true;

  constructor(
    readonly spec: AgentSessionSpec,
    private readonly reply: (prompt: string, session: FakeAgentSession) => string | Promise<string>
  ) {}

  get alive(): boolean {
    return this.#alive;
  }

  async run(prompt: string, context: AgentExecutionContext): Promise<AgentExecutionResult> {
    this.prompts.push(prompt);
    try {
      if (context.signal.aborted) throw new Error("aborted");
      return { output: await this.reply(prompt, this) };
    } catch (error) {
      this.#alive = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#alive = false;
  }
}
