import {
  createHeadlessCore,
  EffortError,
  HeadlessSessionError,
  type AgentSpec,
  type CreateSessionOptions,
  type HeadlessCore,
  type HeadlessRunOptions,
  type HeadlessSession,
  type ProgressEvent
} from "@headless-core/core";
import type { AgentCapabilities } from "../../core/types.js";
import { TEXT_AGENT_CAPABILITIES } from "../../core/capabilities.js";
import { Agent2APIError } from "../../core/errors.js";
import type {
  AgentBackend,
  AgentExecutionContext,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentSession,
  AgentSessionSpec
} from "../backend.js";
import { mapHeadlessCoreError } from "./errorMapper.js";
import { mapAgentSpec } from "./modelMapper.js";
import {
  prepareDirectLaunchers,
  prepareSrtSandbox,
  type HeadlessCoreSandboxConfig,
  type PreparedLaunchers,
  type PreparedSandbox
} from "./sandbox.js";
import { agentTransport, EFFORT_NEEDS_PERSISTENT_TRANSPORT, type HeadlessCoreTransport } from "./transports.js";

/** How long an Agent whose persistent transport failed to start goes back to running its CLI. */
const UNAVAILABLE_RETRY_MS = 5 * 60_000;

/** The longest a request waits for an Agent's persistent transport to open a conversation. */
const DEFAULT_START_TIMEOUT_MS = 60_000;

export interface HeadlessCoreLike {
  run(options: HeadlessRunOptions): Promise<string>;
  createSession?(options: CreateSessionOptions): Promise<HeadlessSession>;
  shutdown?(): Promise<void>;
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
  /**
   * Keeps Agents running between requests over their persistent transport (codex app-server, ACP,
   * the Claude Agent SDK), so conversations can stay open. Off when omitted.
   */
  readonly sessions?: { readonly idleTimeoutMs: number } | false;
  /** Transport per Agent; `cli` keeps that Agent on its CLI. Others use their persistent transport. */
  readonly transports?: Readonly<Partial<Record<string, HeadlessCoreTransport>>>;
  /** Agents to start right away, so the first request finds them running. */
  readonly prewarm?: readonly string[];
  /** Reports problems that do not fail a request, such as falling back to the CLI. */
  readonly onWarning?: (message: string) => void;
  /** How long to wait for a persistent transport to open a conversation before using the CLI. Defaults to 60 seconds. */
  readonly startTimeoutMs?: number;
}

export class HeadlessCoreBackend implements AgentBackend {
  readonly id = "headless-core";
  readonly #headless: HeadlessCoreLike;
  readonly #sandbox: PreparedSandbox | undefined;
  readonly #launchers: PreparedLaunchers | undefined;
  readonly #spares: SpareSessions | undefined;
  /** Agents whose persistent transport failed to start, until when they stay on the CLI. */
  readonly #unavailable = new Map<string, number>();

  constructor(private readonly options: HeadlessCoreBackendOptions) {
    if (options.headless) {
      this.#headless = options.headless;
    } else {
      const sandbox = options.sandbox ?? { type: "srt" };
      this.#sandbox = sandbox ? prepareSrtSandbox({ config: sandbox, cwd: options.cwd }) : undefined;
      this.#launchers = this.#sandbox ? undefined : prepareDirectLaunchers();
      this.#headless = createConfiguredHeadlessCore(options, this.#sandbox?.env ?? this.#launchers?.env);
    }
    const create = this.#headless.createSession?.bind(this.#headless);
    if (options.sessions && create) {
      const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      this.#spares = new SpareSessions((agent) => withStartTimeout(create({ agent }), agent, startTimeoutMs), options.sessions.idleTimeoutMs);
      for (const agent of options.prewarm ?? []) {
        const transport = this.#transport(agent);
        if (transport) this.#spares.prepare({ provider: agent, transport }, (error) => this.#fallBack(agent, error));
      }
    }
  }

  async close(): Promise<void> {
    await this.#spares?.close();
    await this.#headless.shutdown?.().catch(() => undefined);
    this.#sandbox?.dispose();
    this.#launchers?.dispose();
  }

  capabilities(): AgentCapabilities {
    return TEXT_AGENT_CAPABILITIES;
  }

  async execute(request: AgentExecutionRequest, context: AgentExecutionContext): Promise<AgentExecutionResult> {
    const agent = request.target.agent;
    const effort = request.reasoning?.effort;
    if (effort && effort !== "default" && EFFORT_NEEDS_PERSISTENT_TRANSPORT.has(agent) && this.#transport(agent)) {
      // The Agent normally runs over its persistent transport, which is down for now, and its CLI has no effort.
      throw new Agent2APIError({
        code: "backend_unavailable",
        message: `${agent} takes a reasoning effort only over its ${this.#transport(agent)} transport, which could not start. ` +
          "Retry later, or send the request without a reasoning effort.",
        retryable: true
      });
    }
    try {
      const output = await this.#headless.run({
        agent: mapAgentSpec(request),
        prompt: request.prompt,
        signal: context.signal,
        ...this.#timeout(context),
        onProgress: (event) => mapProgress(event, context)
      });
      return { output };
    } catch (error) {
      throw mapHeadlessCoreError(error, context.signal, { sandboxed: this.#sandbox !== undefined });
    }
  }

  async openSession(spec: AgentSessionSpec): Promise<AgentSession | undefined> {
    const agent = spec.target.agent;
    const transport = this.#transport(agent);
    if (!this.#spares || !transport) return undefined;
    const until = this.#unavailable.get(agent);
    if (until !== undefined && until > Date.now()) return undefined;
    try {
      const session = await this.#spares.take({ ...mapAgentSpec(spec), transport }, (error) => this.#fallBack(agent, error));
      return new HeadlessAgentSession(session, this.options.timeoutMs, this.#sandbox !== undefined);
    } catch (error) {
      // An effort the model does not take is the request's problem, not the transport's: report it.
      if (error instanceof EffortError) throw mapHeadlessCoreError(error, new AbortController().signal);
      this.#fallBack(agent, error);
      return undefined;
    }
  }

  /** The persistent transport the Agent uses, or undefined when it runs its CLI. */
  #transport(agent: string): Exclude<HeadlessCoreTransport, "cli"> | undefined {
    if (!this.#spares) return undefined;
    const transport = agentTransport(agent, this.options.transports);
    return transport === "cli" ? undefined : transport;
  }

  /** Runs the Agent on its CLI for a while when its persistent transport cannot start. */
  #fallBack(agent: string, error: unknown): void {
    if (!(error instanceof HeadlessSessionError)) return;
    if (!this.#unavailable.has(agent) || this.#unavailable.get(agent)! <= Date.now()) {
      this.options.onWarning?.(
        `${agent}: could not start its ${this.#transport(agent)} transport, so it runs its CLI for each request ` +
          `for the next ${UNAVAILABLE_RETRY_MS / 60_000} minutes. ${error.message}`
      );
    }
    this.#unavailable.set(agent, Date.now() + UNAVAILABLE_RETRY_MS);
  }

  #timeout(context: AgentExecutionContext): { timeoutMs?: number } {
    const timeoutMs = context.timeoutMs ?? this.options.timeoutMs;
    return timeoutMs !== undefined ? { timeoutMs } : {};
  }
}

/** One conversation on a running Agent, as an AgentSession. */
class HeadlessAgentSession implements AgentSession {
  #alive = true;

  constructor(
    private readonly session: HeadlessSession,
    private readonly timeoutMs: number | undefined,
    private readonly sandboxed: boolean
  ) {}

  get alive(): boolean {
    return this.#alive;
  }

  async run(prompt: string, context: AgentExecutionContext): Promise<AgentExecutionResult> {
    if (!this.#alive) {
      throw new Agent2APIError({ code: "backend_unavailable", message: "The Agent conversation was closed" });
    }
    const timeoutMs = context.timeoutMs ?? this.timeoutMs;
    try {
      const output = await this.session.run({
        prompt,
        signal: context.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        onProgress: (event) => mapProgress(event, context)
      });
      return { output };
    } catch (error) {
      // A failed or interrupted turn leaves the conversation in an unknown state.
      void this.close();
      throw mapHeadlessCoreError(error, context.signal, { sandboxed: this.sandboxed });
    }
  }

  async close(): Promise<void> {
    this.#alive = false;
    await this.session.close().catch(() => undefined);
  }
}

interface Spare {
  readonly key: string;
  readonly session: Promise<HeadlessSession>;
}

/**
 * Keeps one unused conversation ready per Agent, opened like the last one asked for. Taking it skips
 * starting the Agent (and, for the Claude Agent SDK, its process). Holding it also keeps the Agent's
 * process running for the next request. A spare unused for `idleTimeoutMs` is closed.
 */
class SpareSessions {
  readonly #spares = new Map<string, Spare>();
  readonly #lastUsed = new Map<string, number>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(
    private readonly create: (agent: AgentSpec) => Promise<HeadlessSession>,
    private readonly idleTimeoutMs: number
  ) {
    this.#sweeper = setInterval(() => this.#sweep(), Math.min(idleTimeoutMs, 60_000));
    this.#sweeper.unref();
  }

  async take(agent: AgentSpec, onError: (error: unknown) => void): Promise<HeadlessSession> {
    const key = specKey(agent);
    const spare = this.#spares.get(agent.provider);
    this.#spares.delete(agent.provider);
    this.#lastUsed.set(agent.provider, Date.now());
    const other = spare && spare.key !== key ? spare : undefined;
    let session = other ? undefined : await spare?.session.catch(() => undefined);
    try {
      session ??= await this.create(agent);
    } catch (error) {
      // The spare opened for another model or effort is still good for that one.
      if (other && !this.#spares.has(agent.provider)) this.#spares.set(agent.provider, other);
      throw error;
    }
    // Opened for another model: close it only now, so the Agent's process stays up in between.
    if (other) void other.session.then((unused) => unused.close()).catch(() => undefined);
    this.prepare(agent, onError);
    return session;
  }

  /** Opens a spare for the Agent unless one is ready. */
  prepare(agent: AgentSpec, onError: (error: unknown) => void): void {
    if (this.#spares.has(agent.provider)) return;
    if (!this.#lastUsed.has(agent.provider)) this.#lastUsed.set(agent.provider, Date.now());
    const spare: Spare = { key: specKey(agent), session: this.create(agent) };
    this.#spares.set(agent.provider, spare);
    spare.session.catch((error: unknown) => {
      if (this.#spares.get(agent.provider) === spare) this.#spares.delete(agent.provider);
      onError(error);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#sweeper);
    const spares = [...this.#spares.values()];
    this.#spares.clear();
    await Promise.all(spares.map((spare) => spare.session.then((session) => session.close()).catch(() => undefined)));
  }

  #sweep(): void {
    const now = Date.now();
    for (const [provider, spare] of this.#spares) {
      if (now - (this.#lastUsed.get(provider) ?? now) <= this.idleTimeoutMs) continue;
      this.#spares.delete(provider);
      void spare.session.then((session) => session.close()).catch(() => undefined);
    }
  }
}

/**
 * Gives up on a conversation that does not open in time. One that opens later is closed, so it
 * does not keep the Agent's process running.
 */
function withStartTimeout(opening: Promise<HeadlessSession>, agent: AgentSpec, timeoutMs: number): Promise<HeadlessSession> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void opening.then((late) => late.close()).catch(() => undefined);
      reject(new HeadlessSessionError("RUNTIME_START_FAILED", `${agent.provider} did not open a conversation within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([opening, timeout]).finally(() => clearTimeout(timer));
}

function specKey(agent: AgentSpec): string {
  return JSON.stringify([agent.provider, agent.transport, agent.model ?? null, agent.reasoningEffort ?? null]);
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
