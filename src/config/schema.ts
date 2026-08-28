import path from "node:path";
import { Agent2APIError } from "../core/errors.js";
import type { AgentModel } from "../core/types.js";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logging: boolean;
  readonly auth?: { readonly bearerToken: string };
}

export interface InterfaceConfig {
  readonly type: "openai";
  readonly mountPath: string;
}

export interface HeadlessCoreConfig {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface Agent2APIConfig {
  readonly server: ServerConfig;
  readonly interfaces: InterfaceConfig[];
  readonly backends: { readonly "headless-core": HeadlessCoreConfig };
  readonly models: { readonly entries: AgentModel[]; readonly aliases: Record<string, string> };
}

const DEFAULT_MODELS: AgentModel[] = [
  model("codex/default", "codex", "default"),
  model("claude/default", "claude", "default"),
  model("claude/sonnet", "claude", "sonnet"),
  model("claude/opus", "claude", "opus"),
  model("claude/haiku", "claude", "haiku"),
  model("grok/default", "grok", "default"),
  model("agy/default", "agy", "default", { reasoningEffort: false })
];

export function parseConfig(value: unknown, baseDirectory = process.cwd()): Agent2APIConfig {
  const root = object(value ?? {}, "config");
  rejectUnknown(root, ["server", "interfaces", "backends", "models"], "config");
  const serverValue = object(root.server ?? {}, "server");
  rejectUnknown(serverValue, ["host", "port", "logging", "auth"], "server");
  const auth = parseAuth(serverValue.auth);
  const server: ServerConfig = {
    host: optionalString(serverValue.host, "server.host") ?? "127.0.0.1",
    port: optionalInteger(serverValue.port, "server.port", 0, 65_535) ?? 8080,
    logging: optionalBoolean(serverValue.logging, "server.logging") ?? true,
    ...(auth ? { auth } : {})
  };

  const interfaces = parseInterfaces(root.interfaces);
  const backendsValue = object(root.backends ?? {}, "backends");
  rejectUnknown(backendsValue, ["headless-core"], "backends");
  const headlessValue = object(backendsValue["headless-core"] ?? {}, "backends.headless-core");
  rejectUnknown(headlessValue, ["cwd", "timeoutMs"], "backends.headless-core");
  const configuredCwd = optionalString(headlessValue.cwd, "backends.headless-core.cwd") ?? ".";
  const backends = {
    "headless-core": {
      cwd: path.resolve(baseDirectory, configuredCwd),
      timeoutMs: optionalInteger(headlessValue.timeoutMs, "backends.headless-core.timeoutMs", 1) ?? 120_000
    }
  };

  const modelsValue = object(root.models ?? {}, "models");
  rejectUnknown(modelsValue, ["entries", "aliases"], "models");
  const entries = modelsValue.entries === undefined ? DEFAULT_MODELS : parseModels(modelsValue.entries);
  const aliasesValue = object(modelsValue.aliases ?? { default: "codex/default" }, "models.aliases");
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliasesValue)) aliases[alias] = requiredString(target, `models.aliases.${alias}`);

  return { server, interfaces, backends, models: { entries, aliases } };
}

function parseInterfaces(value: unknown): InterfaceConfig[] {
  if (value === undefined) return [{ type: "openai", mountPath: "" }];
  if (!Array.isArray(value) || value.length === 0) invalid("interfaces must be a non-empty array", "interfaces");
  return value.map((item, index) => {
    const entry = object(item, `interfaces.${index}`);
    rejectUnknown(entry, ["type", "mountPath"], `interfaces.${index}`);
    if (entry.type !== "openai") {
      throw new Agent2APIError({
        code: "unsupported_feature",
        message: `Protocol '${String(entry.type)}' is not available in this release`,
        param: `interfaces.${index}.type`
      });
    }
    const mountPath = entry.mountPath ?? "";
    if (typeof mountPath !== "string") {
      invalid(`interfaces.${index}.mountPath must be a string`, `interfaces.${index}.mountPath`);
    }
    if (mountPath !== "" && (!mountPath.startsWith("/") || mountPath.endsWith("/"))) {
      invalid("interface mountPath must be empty or start with '/' and have no trailing slash", `interfaces.${index}.mountPath`);
    }
    return { type: "openai", mountPath };
  });
}

function parseModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) invalid("models.entries must be an array", "models.entries");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const entry = object(item, `models.entries.${index}`);
    rejectUnknown(entry, ["id", "backend", "agent", "model", "ownedBy", "capabilities"], `models.entries.${index}`);
    const id = requiredString(entry.id, `models.entries.${index}.id`);
    if (ids.has(id)) invalid(`Duplicate model id '${id}'`, `models.entries.${index}.id`);
    ids.add(id);
    const capabilities = entry.capabilities === undefined ? undefined : parseCapabilities(entry.capabilities, `models.entries.${index}.capabilities`);
    return {
      id,
      target: {
        backend: requiredString(entry.backend, `models.entries.${index}.backend`),
        agent: requiredString(entry.agent, `models.entries.${index}.agent`),
        model: requiredString(entry.model, `models.entries.${index}.model`)
      },
      ...(entry.ownedBy !== undefined ? { ownedBy: requiredString(entry.ownedBy, `models.entries.${index}.ownedBy`) } : {}),
      ...(capabilities ? { capabilities } : {})
    };
  });
}

function parseCapabilities(value: unknown, param: string): AgentModel["capabilities"] {
  const input = object(value, param);
  const allowed = ["textInput", "textOutput", "streaming", "reasoningEffort", "externalTools", "imageInput", "audioInput", "fileInput"];
  rejectUnknown(input, allowed, param);
  const output: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(input)) output[key] = optionalBoolean(item, `${param}.${key}`) ?? false;
  return output;
}

function parseAuth(value: unknown): ServerConfig["auth"] {
  if (value === undefined || value === null) return undefined;
  const input = object(value, "server.auth");
  rejectUnknown(input, ["bearerToken"], "server.auth");
  return { bearerToken: requiredString(input.bearerToken, "server.auth.bearerToken") };
}

function model(id: string, agent: string, modelId: string, capabilities?: AgentModel["capabilities"]): AgentModel {
  return {
    id,
    target: { backend: "headless-core", agent, model: modelId },
    ownedBy: "agent2api",
    ...(capabilities ? { capabilities } : {})
  };
}

function object(value: unknown, param: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${param} must be an object`, param);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, param: string): string {
  const result = optionalString(value, param);
  if (result === undefined) invalid(`${param} is required`, param);
  return result;
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) invalid(`${param} must be a non-empty string`, param);
  return value;
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${param} must be a boolean`, param);
  return value;
}

function optionalInteger(value: unknown, param: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${param} must be an integer between ${min} and ${max}`, param);
  }
  return value as number;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], param: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`Unknown configuration field '${param}.${key}'`, `${param}.${key}`);
  }
}

function invalid(message: string, param: string): never {
  throw new Agent2APIError({ code: "invalid_request", message, param });
}
