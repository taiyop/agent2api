import { describe, expect, it, vi } from "vitest";
import { EffortError, HeadlessSessionError, type AgentSpec, type HeadlessRunOptions, type HeadlessSession } from "@headless-core/core";
import { HeadlessCoreBackend } from "../../src/backends/headless-core/backend.js";
import { mapHeadlessCoreError } from "../../src/backends/headless-core/errorMapper.js";
import { resolveHeadlessCoreModel } from "../../src/backends/headless-core/modelMapper.js";

function request() {
  return {
    requestId: "req_1",
    modelId: "codex/default",
    target: { backend: "headless-core", agent: "codex", model: "default" },
    prompt: "[USER]\nHello",
    reasoning: { effort: "high" }
  };
}

describe("HeadlessCoreBackend", () => {
  it("preserves default model and forwards reasoning, signal, timeout, and prompt", async () => {
    let captured: HeadlessRunOptions | undefined;
    const headless = {
      run: vi.fn(async (options: HeadlessRunOptions) => {
        captured = options;
        await options.onProgress?.({ state: "running", partialOutput: "stderr or stdout" });
        return "Hello.";
      })
    };
    const backend = new HeadlessCoreBackend({ cwd: "/project", timeoutMs: 120_000, headless });
    const controller = new AbortController();
    const progress = vi.fn();
    await expect(backend.execute(request(), { signal: controller.signal, timeoutMs: 5000, onProgress: progress }))
      .resolves.toEqual({ output: "Hello." });

    expect(captured).toMatchObject({
      agent: { provider: "codex", model: "default", reasoningEffort: "high" },
      prompt: "[USER]\nHello",
      signal: controller.signal,
      timeoutMs: 5000
    });
    expect(progress).toHaveBeenCalledWith({ type: "execution.output", stream: "unknown" });
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ delta: expect.anything() }));
  });

  it("passes an already-aborted signal through and maps cancellation", async () => {
    let receivedSignal: AbortSignal | undefined;
    const backend = new HeadlessCoreBackend({
      cwd: "/project",
      headless: {
        async run(options) {
          receivedSignal = options.signal;
          throw new Error("stopped");
        }
      }
    });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.execute(request(), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(receivedSignal).toBe(controller.signal);
  });
});

/** A headless core whose sessions record their prompts; `failCreate` makes createSession throw. */
function sessionCore(options: { failCreate?: unknown } = {}) {
  const sessions: Array<{ agent: AgentSpec; prompts: string[]; closed: boolean }> = [];
  const core = {
    run: vi.fn(async () => "from cli"),
    createSession: vi.fn(async ({ agent }: { agent: AgentSpec }): Promise<HeadlessSession> => {
      if (options.failCreate) throw options.failCreate;
      const record = { agent, prompts: [] as string[], closed: false };
      sessions.push(record);
      return {
        provider: agent.provider,
        transport: agent.transport ?? "cli",
        id: `s${sessions.length}`,
        async run({ prompt }) {
          record.prompts.push(prompt);
          return `turn ${record.prompts.length}`;
        },
        async reset() {},
        async setModel() {},
        async getAvailableModels() { return []; },
        async close() { record.closed = true; }
      };
    }),
    shutdown: vi.fn(async () => {})
  };
  return { core, sessions };
}

const sessionSpec = (model = "default") => ({
  requestId: "req_1",
  modelId: `codex/${model}`,
  target: { backend: "headless-core", agent: "codex", model }
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("HeadlessCoreBackend sessions", () => {
  it("opens conversations over the Agent's persistent transport and keeps a spare ready", async () => {
    const { core, sessions } = sessionCore();
    const backend = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 } });
    const session = await backend.openSession(sessionSpec());
    expect(sessions[0]!.agent).toEqual({ provider: "codex", model: "default", transport: "app-server" });
    await expect(session!.run("hi", { signal: new AbortController().signal })).resolves.toEqual({ output: "turn 1" });
    await expect(session!.run("again", { signal: new AbortController().signal })).resolves.toEqual({ output: "turn 2" });

    // A spare for the same model was opened in the background and is handed out next.
    await flush();
    expect(sessions).toHaveLength(2);
    await backend.openSession(sessionSpec());
    await flush();
    expect(core.createSession).toHaveBeenCalledTimes(3);
    expect(sessions[1]!.closed).toBe(false);

    // A spare opened for another model is closed once the new conversation is open.
    await backend.openSession(sessionSpec("gpt-6.2-sol"));
    await flush();
    expect(sessions[2]!.closed).toBe(true);
    await backend.close();
    expect(core.shutdown).toHaveBeenCalled();
  });

  it("starts the Agents listed in prewarm right away", async () => {
    const { core, sessions } = sessionCore();
    new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, prewarm: ["claude"] });
    await flush();
    expect(sessions.map((session) => session.agent)).toEqual([{ provider: "claude", transport: "sdk" }]);
  });

  it("keeps an Agent on its CLI when transports says so, or when sessions are off", async () => {
    const { core } = sessionCore();
    const cli = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, transports: { codex: "cli" } });
    await expect(cli.openSession(sessionSpec())).resolves.toBeUndefined();
    const off = new HeadlessCoreBackend({ cwd: "/project", headless: core });
    await expect(off.openSession(sessionSpec())).resolves.toBeUndefined();
    expect(core.createSession).not.toHaveBeenCalled();
  });

  it("asks to retry a Mistral effort while ACP is down, since the Vibe CLI takes no effort", async () => {
    const { core } = sessionCore({ failCreate: new HeadlessSessionError("RUNTIME_START_FAILED", "vibe-acp exited") });
    const backend = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, onWarning: () => {} });
    const target = { backend: "headless-core", agent: "mistral", model: "default" };
    const spec = { requestId: "req_1", modelId: "mistral/default", target, reasoning: { effort: "high" } };
    await expect(backend.openSession(spec)).resolves.toBeUndefined();
    const context = { signal: new AbortController().signal };
    await expect(backend.execute({ ...spec, prompt: "hi" }, context)).rejects.toMatchObject({
      code: "backend_unavailable",
      retryable: true,
      message: expect.stringContaining("only over its acp transport")
    });
    const { reasoning: _effort, ...withoutEffort } = spec;
    await expect(backend.execute({ ...withoutEffort, prompt: "hi" }, context)).resolves.toEqual({ output: "from cli" });
    expect(core.run).toHaveBeenCalledTimes(1);
  });

  it("reports an effort the model does not take, and keeps the spare it had", async () => {
    const { core, sessions } = sessionCore();
    const create = core.createSession;
    core.createSession = vi.fn(async (options: { agent: AgentSpec }) => {
      if (options.agent.reasoningEffort === "low") {
        throw new EffortError("UNSUPPORTED_EFFORT", 'Model "mistral-medium-latest" does not support reasoning effort "low". Supported efforts: none, high.');
      }
      return create(options);
    });
    const warnings: string[] = [];
    const backend = new HeadlessCoreBackend({
      cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, prewarm: ["mistral"], onWarning: (message) => warnings.push(message)
    });
    await flush();
    const target = { backend: "headless-core", agent: "mistral", model: "mistral-medium-latest" };
    await expect(backend.openSession({ requestId: "req_1", modelId: "mistral/x", target, reasoning: { effort: "low" } })).rejects.toMatchObject({
      code: "unsupported_feature",
      statusCode: 400,
      param: "reasoning.effort",
      message: expect.stringContaining("Supported efforts: none, high.")
    });
    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(false);
    await backend.close();
  });

  it("falls back to the CLI for a while when the persistent transport cannot start", async () => {
    const failure = new HeadlessSessionError("RUNTIME_START_FAILED", "Cannot find package '@anthropic-ai/claude-agent-sdk'");
    const { core } = sessionCore({ failCreate: failure });
    const warnings: string[] = [];
    const backend = new HeadlessCoreBackend({
      cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, onWarning: (message) => warnings.push(message)
    });
    await expect(backend.openSession(sessionSpec())).resolves.toBeUndefined();
    await expect(backend.openSession(sessionSpec())).resolves.toBeUndefined();
    expect(core.createSession).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([expect.stringContaining("codex: could not start its app-server transport")]);
  });

  it("keeps Agy on its CLI unless transports picks acp", async () => {
    const { core } = sessionCore();
    const agy = { requestId: "r", modelId: "agy/default", target: { backend: "headless-core", agent: "agy", model: "default" } };
    const defaults = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 } });
    await expect(defaults.openSession(agy)).resolves.toBeUndefined();
    const acp = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, transports: { agy: "acp" } });
    await expect(acp.openSession(agy)).resolves.toBeDefined();
  });

  it("uses the CLI when a conversation does not open in time, and closes it if it opens later", async () => {
    let open: ((session: HeadlessSession) => void) | undefined;
    const late = { close: vi.fn(async () => {}) } as unknown as HeadlessSession;
    const core = {
      run: vi.fn(async () => "from cli"),
      createSession: vi.fn(() => new Promise<HeadlessSession>((resolve) => { open = resolve; }))
    };
    const warnings: string[] = [];
    const backend = new HeadlessCoreBackend({
      cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 }, startTimeoutMs: 20, onWarning: (message) => warnings.push(message)
    });
    await expect(backend.openSession(sessionSpec())).resolves.toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("did not open a conversation within")]);
    open!(late);
    await flush();
    expect(late.close).toHaveBeenCalled();
  });

  it("closes a conversation whose turn failed and reports the error like the CLI", async () => {
    const { core } = sessionCore();
    const backend = new HeadlessCoreBackend({ cwd: "/project", headless: core, sessions: { idleTimeoutMs: 60_000 } });
    const session = await backend.openSession(sessionSpec());
    const created = await core.createSession.mock.results[0]!.value as HeadlessSession;
    vi.spyOn(created, "run").mockRejectedValueOnce(new HeadlessSessionError("REQUEST_TIMEOUT", "Run timed out after 5ms"));
    await expect(session!.run("hi", { signal: new AbortController().signal })).rejects.toMatchObject({ code: "timeout" });
    expect(session!.alive).toBe(false);
  });
});

describe("mapHeadlessCoreError", () => {
  it("explains a sandbox local-binding denial only when the Agent ran sandboxed", () => {
    const signal = new AbortController().signal;
    const error = new Error("Failed to start: listen tcp 127.0.0.1:0: bind: operation not permitted");
    expect(mapHeadlessCoreError(error, signal, { sandboxed: true })).toMatchObject({
      code: "backend_unavailable",
      message: expect.stringContaining("allowLocalBinding")
    });
    expect(mapHeadlessCoreError(error, signal).message).not.toContain("allowLocalBinding");
  });

  it("maps rate limits, timeouts, and authentication failures", () => {
    const signal = new AbortController().signal;
    expect(mapHeadlessCoreError({ cause: { error: { kind: "rate_limit" } } }, signal)).toMatchObject({ code: "rate_limit" });
    expect(mapHeadlessCoreError(new Error("Command timed out"), signal)).toMatchObject({ code: "timeout" });
    expect(mapHeadlessCoreError(new Error("not authenticated"), signal)).toMatchObject({
      code: "backend_unavailable",
      message: expect.stringContaining("already authenticated")
    });
  });
});

describe("resolveHeadlessCoreModel", () => {
  it("routes supported agent/model ids without checking model availability", () => {
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna")).toEqual({
      id: "codex/gpt-5.6-luna",
      target: { backend: "headless-core", agent: "codex", model: "gpt-5.6-luna" },
      ownedBy: "agent2api"
    });
    expect(resolveHeadlessCoreModel("agy/custom")).toMatchObject({ capabilities: { reasoningEffort: false } });
    expect(resolveHeadlessCoreModel("mistral/devstral")).toEqual({
      id: "mistral/devstral",
      target: { backend: "headless-core", agent: "mistral", model: "devstral" },
      ownedBy: "agent2api",
      capabilities: { reasoningEffort: false }
    });
    // On ACP, Mistral takes an effort; Agy still takes none.
    const acp = { withoutEffort: new Set(["agy"]) };
    expect(resolveHeadlessCoreModel("mistral/devstral", acp)).not.toHaveProperty("capabilities");
    expect(resolveHeadlessCoreModel("agy/custom", acp)).toMatchObject({ capabilities: { reasoningEffort: false } });
  });

  it("extracts an optional recognized reasoning effort suffix", () => {
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna/low")).toEqual({
      id: "codex/gpt-5.6-luna/low",
      target: { backend: "headless-core", agent: "codex", model: "gpt-5.6-luna" },
      defaultReasoning: { effort: "low" },
      ownedBy: "agent2api"
    });
    expect(resolveHeadlessCoreModel("codex/vendor/model-name")).toMatchObject({
      target: { model: "vendor/model-name" }
    });
    expect(resolveHeadlessCoreModel("codex/gpt-5.6-luna/default")).not.toHaveProperty("defaultReasoning");
  });

  it.each(["codex", "unknown/model", "/model", "codex/", "codex//model", "codex/model/", "codex/model with spaces"])(
    "does not route malformed or unsupported id %s",
    (modelId) => expect(resolveHeadlessCoreModel(modelId)).toBeUndefined()
  );
});
