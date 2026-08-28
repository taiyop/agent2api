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
      "codex/default", "claude/sonnet", "grok/default", "agy/default"
    ]));
  });

  it.each(["env", "command", "binary", "args"])("rejects forbidden backend configuration field %s", (field) => {
    expect(() => parseConfig({ backends: { "headless-core": { [field]: "unsafe" } } }))
      .toThrowError(expect.objectContaining({ code: "invalid_request", param: `backends.headless-core.${field}` }));
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
});
