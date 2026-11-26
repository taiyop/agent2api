import { createHeadlessCore, type HeadlessCore, type HeadlessRunOptions, type ProgressEvent } from "@headless-core/core";
import type { AgentCapabilities } from "../../core/types.js";
import { TEXT_AGENT_CAPABILITIES } from "../../core/capabilities.js";
import type { AgentBackend, AgentExecutionContext, AgentExecutionRequest, AgentExecutionResult } from "../backend.js";
import { mapHeadlessCoreError } from "./errorMapper.js";
import { mapAgentSpec } from "./modelMapper.js";
import {
  prepareDirectLaunchers,
  prepareSrtSandbox,
  type HeadlessCoreSandboxConfig,
  type PreparedLaunchers,
  type PreparedSandbox
} from "./sandbox.js";

export interface HeadlessCoreLike {
  run(options: HeadlessRunOptions): Promise<string>;
}

export interface HeadlessCoreBackendOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /**
   * Runs every Agent CLI inside an OS-level sandbox. Defaults to `{ type: "srt" }`; pass `false` to
   * run without one. Ignored when `headless` is given.
   */
  readonly sandbox?: HeadlessCoreSandboxConfig | false;
  readonly headless?: HeadlessCoreLike;
}

export class HeadlessCoreBackend implements AgentBackend {
  readonly id = "headless-core";
  readonly #headless: HeadlessCoreLike;
  readonly #sandbox: PreparedSandbox | undefined;
  readonly #launchers: PreparedLaunchers | undefined;

  constructor(private readonly options: HeadlessCoreBackendOptions) {
    if (options.headless) {
      this.#headless = options.headless;
    } else {
      const sandbox = options.sandbox ?? { type: "srt" };
      this.#sandbox = sandbox ? prepareSrtSandbox({ config: sandbox, cwd: options.cwd }) : undefined;
      this.#launchers = this.#sandbox ? undefined : prepareDirectLaunchers();
      this.#headless = createConfiguredHeadlessCore(options, this.#sandbox?.env ?? this.#launchers?.env);
    }
  }

  close(): void {
    this.#sandbox?.dispose();
    this.#launchers?.dispose();
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
      throw mapHeadlessCoreError(error, context.signal, { sandboxed: this.#sandbox !== undefined });
    }
  }
}

function createConfiguredHeadlessCore(options: HeadlessCoreBackendOptions, env: NodeJS.ProcessEnv | undefined): HeadlessCore {
  return createHeadlessCore({
    cwd: options.cwd,
    ...(env ? { env } : {}),
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
