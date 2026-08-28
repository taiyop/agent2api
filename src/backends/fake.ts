import { TEXT_AGENT_CAPABILITIES } from "../core/capabilities.js";
import type { AgentCapabilities } from "../core/types.js";
import type { AgentBackend, AgentExecutionContext, AgentExecutionRequest, AgentExecutionResult } from "./backend.js";

export interface FakeBackendOptions {
  readonly output?: string;
  readonly execute?: (request: AgentExecutionRequest, context: AgentExecutionContext) => Promise<AgentExecutionResult>;
}

export class FakeAgentBackend implements AgentBackend {
  readonly id = "fake";
  readonly requests: AgentExecutionRequest[] = [];
  readonly contexts: AgentExecutionContext[] = [];

  constructor(private readonly options: FakeBackendOptions = {}) {}

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
