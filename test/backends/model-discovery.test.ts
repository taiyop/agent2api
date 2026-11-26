import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessCoreBackend } from "../../src/backends/headless-core/backend.js";
import {
  discoverHeadlessCoreModels,
  headlessCoreEffortVariants,
  resolveHeadlessCoreModel
} from "../../src/backends/headless-core/modelMapper.js";
import { parseConfig } from "../../src/config/schema.js";
import { StaticModelRegistry } from "../../src/core/modelRegistry.js";
import { createServer } from "../../src/transport/http/server.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "agent2api-models-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function useModelsFile(content: unknown): void {
  const file = path.join(directory, "models.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  vi.stubEnv("HEADLESS_CORE_MODELS_PATH", file);
}

describe("headless_core models.json discovery", () => {
  it("lists every candidate as <agent>/<model>, with default first, and skips agents without candidates", async () => {
    useModelsFile({ models: { codex: ["gpt-6-luna", "gpt-6-sol"], agy: ["gemini-3.8-flash-low"], grok: [] } });
    const models = await discoverHeadlessCoreModels();
    expect(models.map((model) => model.id)).toEqual([
      "codex/default", "codex/gpt-6-luna", "codex/gpt-6-sol", "agy/default", "agy/gemini-3.8-flash-low"
    ]);
    expect(models[1]?.target).toEqual({ backend: "headless-core", agent: "codex", model: "gpt-6-luna" });
    expect(models[4]?.capabilities).toEqual({ reasoningEffort: false });
  });

  it("lists nothing when there is no models.json, and reports a broken one", async () => {
    vi.stubEnv("HEADLESS_CORE_MODELS_PATH", path.join(directory, "missing.json"));
    expect(await discoverHeadlessCoreModels()).toEqual([]);
    useModelsFile("{ not json");
    await expect(discoverHeadlessCoreModels()).rejects.toThrow(/not valid JSON/);
  });

  it("adds discovered models after the configured ones without duplicates", async () => {
    useModelsFile({ models: { claude: ["sonnet", "fable"] } });
    const config = parseConfig({});
    const registry = new StaticModelRegistry({ ...config.models, discover: discoverHeadlessCoreModels });
    const ids = (await registry.listAvailable()).map((model) => model.id);
    expect(ids.filter((id) => id === "claude/sonnet")).toHaveLength(1);
    expect(ids.slice(0, 7)).toEqual([
      "default", "codex/default", "claude/default", "claude/sonnet", "claude/opus", "claude/haiku", "claude/fable"
    ]);
  });

  it("lists aliases, their targets, and each model's effort forms right after it", async () => {
    useModelsFile({ models: { codex: ["gpt-6-luna"], agy: ["gemini-3.8-flash-low"] } });
    const config = parseConfig({
      models: {
        entries: [],
        aliases: { "luna-low": "codex/gpt-5.6-luna/low", smart: "claude/sonnet" }
      }
    });
    const registry = new StaticModelRegistry({
      ...config.models,
      resolveUnknown: resolveHeadlessCoreModel,
      discover: discoverHeadlessCoreModels,
      variants: headlessCoreEffortVariants
    });
    const ids = (await registry.listAvailable()).map((model) => model.id);
    expect(ids.slice(0, 2)).toEqual(["luna-low", "smart"]);
    expect(ids).toContain("codex/gpt-5.6-luna/low");
    const luna = ids.indexOf("codex/gpt-6-luna");
    expect(ids.slice(luna, luna + 8)).toEqual([
      "codex/gpt-6-luna",
      ...["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((effort) => `codex/gpt-6-luna/${effort}`)
    ]);
    expect(ids).toContain("claude/sonnet/high");
    expect(ids).not.toContain("codex/gpt-5.6-luna/low/low");
    expect(ids.filter((id) => id.startsWith("agy/"))).toEqual(["agy/default", "agy/gemini-3.8-flash-low"]);
  });

  it("lists Mistral's effort forms only while Mistral runs on ACP", async () => {
    useModelsFile({ models: { mistral: ["devstral"] } });
    const ids = async (input: Record<string, unknown>) => {
      const server = createServer(parseConfig({ server: { logging: false }, ...input }), {
        backends: [new HeadlessCoreBackend({ cwd: directory, headless: { run: async () => "ok" } })]
      });
      try {
        return ((await server.inject({ method: "GET", url: "/v1/models" })).json() as { data: Array<{ id: string }> })
          .data.map((entry) => entry.id).filter((id) => id.startsWith("mistral/"));
      } finally {
        await server.close();
      }
    };
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(await ids({})).toEqual([
      "mistral/default", ...efforts.map((effort) => `mistral/default/${effort}`),
      "mistral/devstral", ...efforts.map((effort) => `mistral/devstral/${effort}`)
    ]);
    const cli = ["mistral/default", "mistral/devstral"];
    expect(await ids({ sessions: { enabled: false } })).toEqual(cli);
    expect(await ids({ backends: { "headless-core": { transports: { mistral: "cli" } } } })).toEqual(cli);
  });

  it("leaves effort forms out when listEffortVariants is false", () => {
    expect(parseConfig({ models: { listEffortVariants: false } }).models.listEffortVariants).toBe(false);
    expect(parseConfig({}).models.listEffortVariants).toBe(true);
  });

  it("serves models.json candidates from /v1/models and picks up edits without a restart", async () => {
    useModelsFile({ models: { codex: ["gpt-6-luna"] } });
    const config = parseConfig({ server: { logging: false } });
    const server = createServer(config, {
      backends: [new HeadlessCoreBackend({ cwd: directory, headless: { run: async () => "ok" } })]
    });
    try {
      const list = async () => (await server.inject({ method: "GET", url: "/v1/models" })).json() as { data: Array<{ id: string }> };
      expect((await list()).data.map((entry) => entry.id)).toContain("codex/gpt-6-luna");
      useModelsFile({ models: { codex: ["gpt-6-sol"] } });
      const ids = (await list()).data.map((entry) => entry.id);
      expect(ids).toContain("codex/gpt-6-sol");
      expect(ids).not.toContain("codex/gpt-6-luna");
    } finally {
      await server.close();
    }
  });
});
