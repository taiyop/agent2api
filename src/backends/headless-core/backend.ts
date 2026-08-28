import { createHeadlessCore, type HeadlessCore, type HeadlessRunOptions, type ProgressEvent } from "@headless-core/core";
import type { AgentCapabilities } from "../../core/types.js";
import { TEXT_AGENT_CAPABILITIES } from "../../core/capabilities.js";
import type { AgentBackend, AgentExecutionContext, AgentExecutionRequest, AgentExecutionResult } from "../backend.js";
import { mapHeadlessCoreError } from "./errorMapper.js";
import { mapAgentSpec } from "./modelMapper.js";

export interface HeadlessCoreLike {
  run(options: HeadlessRunOptions): Promise<string>;
}

export interface HeadlessCoreBackendOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly headless?: HeadlessCoreLike;
}

export class HeadlessCoreBackend implements AgentBackend {
  readonly id = "headless-core";
  readonly #headless: HeadlessCoreLike;

  constructor(private readonly options: HeadlessCoreBackendOptions) {
    this.#headless = options.headless ?? createConfiguredHeadlessCore(options);
  }

  capabilities(): AgentCapabilities {
    return TEXT_AGENT_CAPABILITIES;
  }

  async execute(request: AgentExecutionRequest, context: AgentExecutionContext): Promise<AgentExecutionResult> {
    try {
      const output = await this.#headless.run({
        agent: mapAgentSpec(request),
        prompt: request.prompt,
        signal: context.signal,
        ...(context.timeoutMs ?? this.options.timeoutMs) !== undefined
          ? { timeoutMs: context.timeoutMs ?? this.options.timeoutMs }
          : {},
        onProgress: (event) => mapProgress(event, context)
      });
      return { output };
    } catch (error) {
      throw mapHeadlessCoreError(error, context.signal);
    }
  }
}

function createConfiguredHeadlessCore(options: HeadlessCoreBackendOptions): HeadlessCore {
  return createHeadlessCore({
    cwd: options.cwd,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
}

function mapProgress(event: ProgressEvent, context: AgentExecutionContext): void {
  context.onProgress?.({
    type: "execution.state",
    state: event.state,
    ...(event.message ? { message: event.message } : {})
  });
  if (event.partialOutput !== undefined) {
    context.onProgress?.({ type: "execution.output", stream: "unknown" });
  }
}
