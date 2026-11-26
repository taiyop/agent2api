import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/schema.js";

describe("configuration", () => {
  it("uses secure defaults and resolves cwd from the config directory", () => {
    const config = parseConfig({ backends: { "headless-core": { cwd: "project" } } }, "/config");
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 8080 });
    expect(config.interfaces).toEqual([{ type: "openai", mountPath: "" }]);
    expect(config.backends["headless-core"].cwd).toBe(path.resolve("/config/project"));
    expect(config.models.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "codex/default", "claude/sonnet", "grok/default", "agy/default", "mistral/default"
    ]));
  });

  it.each(["env", "command", "binary", "args"])("rejects forbidden backend configuration field %s", (field) => {
    expect(() => parseConfig({ backends: { "headless-core": { [field]: "unsafe" } } }))
      .toThrowError(expect.objectContaining({ code: "invalid_request", param: `backends.headless-core.${field}` }));
  });

  it("keeps sessions on by default and validates transports and prewarm", () => {
    const defaults = parseConfig({});
    expect(defaults.sessions).toEqual({ enabled: true, idleTimeoutSeconds: 600, maxConversations: 8 });
    expect(defaults.backends["headless-core"]).toMatchObject({ transports: {}, prewarm: [] });

    const config = parseConfig({
      sessions: { enabled: false, idleTimeoutSeconds: 30, maxConversations: 0 },
      backends: { "headless-core": { transports: { grok: "cli", codex: "app-server" }, prewarm: ["codex", "codex", "claude"] } }
    });
    expect(config.sessions).toEqual({ enabled: false, idleTimeoutSeconds: 30, maxConversations: 0 });
    expect(config.backends["headless-core"]).toMatchObject({ transports: { grok: "cli", codex: "app-server" }, prewarm: ["codex", "claude"] });

    expect(() => parseConfig({ backends: { "headless-core": { transports: { codex: "acp" } } } }))
      .toThrowError(expect.objectContaining({ param: "backends.headless-core.transports.codex", message: expect.stringContaining("'cli' or 'app-server'") }));
    expect(() => parseConfig({ backends: { "headless-core": { prewarm: ["gemini"] } } }))
      .toThrowError(expect.objectContaining({ param: "backends.headless-core.prewarm.0" }));
    expect(() => parseConfig({ sessions: { ttl: 5 } }))
      .toThrowError(expect.objectContaining({ param: "sessions.ttl" }));
  });

  it("lets the built-in mistral model take an effort only while Mistral runs on ACP", () => {
    const mistral = (input: Record<string, unknown>) =>
      parseConfig(input).models.entries.find((entry) => entry.id === "mistral/default")?.capabilities;
    expect(mistral({})).toBeUndefined();
    expect(mistral({ sessions: { enabled: false } })).toEqual({ reasoningEffort: false });
    expect(mistral({ backends: { "headless-core": { transports: { mistral: "cli" } } } })).toEqual({ reasoningEffort: false });
    expect(parseConfig({}).models.entries.find((entry) => entry.id === "agy/default")?.capabilities)
      .toEqual({ reasoningEffort: false });
  });

  it("rejects the removed server heartbeat interval field", () => {
    expect(() => parseConfig({ server: { heartbeatIntervalMs: 5_000 } }))
      .toThrowError(expect.objectContaining({
        code: "invalid_request",
        param: "server.heartbeatIntervalMs"
      }));
  });

  it("allows an empty explicit catalog because headless-core resolves canonical models dynamically", () => {
    expect(parseConfig({ models: { entries: [], aliases: {} } }).models.entries).toEqual([]);
  });

  it("accepts an explicit interface mount path", () => {
    expect(parseConfig({ interfaces: [{ type: "openai", mountPath: "/api" }] }).interfaces)
      .toEqual([{ type: "openai", mountPath: "/api" }]);
  });

  it("rejects the removed interface prefix field", () => {
    expect(() => parseConfig({ interfaces: [{ type: "openai", prefix: "/v1" }] }))
      .toThrowError(expect.objectContaining({
        code: "invalid_request",
        param: "interfaces.0.prefix"
      }));
  });

  it.each(["api", "/api/"])("rejects invalid interface mount path %s", (mountPath) => {
    expect(() => parseConfig({ interfaces: [{ type: "openai", mountPath }] }))
      .toThrowError(expect.objectContaining({
        code: "invalid_request",
        param: "interfaces.0.mountPath"
      }));
  });
  it("turns the srt sandbox on by default and off only with false", () => {
    expect(parseConfig({}).backends["headless-core"].sandbox).toEqual({ type: "srt" });
    expect(parseConfig({ backends: { "headless-core": { sandbox: false } } }).backends["headless-core"].sandbox)
      .toBe(false);
    expect(parseConfig({ backends: { "headless-core": { sandbox: { agents: { agy: {} } } } } }).backends["headless-core"].sandbox)
      .toEqual({ type: "srt", agents: { agy: {} } });
  });

  it("parses an srt sandbox and resolves relative paths from the config directory", () => {
    const config = parseConfig({
      backends: {
        "headless-core": {
          sandbox: {
            type: "srt",
            network: { allowedDomains: ["example.com"] },
            filesystem: { allowWrite: ["out", "~/cache", "/abs"] },
            agents: { agy: { network: { allowLocalBinding: false }, enableWeakerNetworkIsolation: true } }
          }
        }
      }
    }, "/config");
    expect(config.backends["headless-core"].sandbox).toEqual({
      type: "srt",
      network: { allowedDomains: ["example.com"] },
      filesystem: { allowWrite: [path.resolve("/config/out"), "~/cache", "/abs"] },
      agents: { agy: { network: { allowLocalBinding: false }, enableWeakerNetworkIsolation: true } }
    });
  });

  it.each([
    [true, "backends.headless-core.sandbox"],
    [null, "backends.headless-core.sandbox"],
    [{ type: "docker" }, "backends.headless-core.sandbox.type"],
    [{ type: "srt", agents: { gemini: {} } }, "backends.headless-core.sandbox.agents.gemini"],
    [{ type: "srt", network: { allowedDomains: "example.com" } }, "backends.headless-core.sandbox.network.allowedDomains"],
    [{ type: "srt", filesystem: { allowExec: [] } }, "backends.headless-core.sandbox.filesystem.allowExec"],
    [{ type: "srt", settingsPath: "./srt.json" }, "backends.headless-core.sandbox.settingsPath"]
  ])("rejects invalid sandbox configuration %j", (sandbox, param) => {
    expect(() => parseConfig({ backends: { "headless-core": { sandbox } } }))
      .toThrowError(expect.objectContaining({ code: "invalid_request", param }));
  });
});
