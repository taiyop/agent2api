import { Agent2APIError } from "./errors.js";
import type { AgentModel, AgentModelTarget } from "./types.js";

export interface ModelRegistry {
  resolve(modelId: string): AgentModelTarget;
  get(modelId: string): AgentModel;
  list(): AgentModel[];
}

export interface StaticModelRegistryOptions {
  readonly entries: AgentModel[];
  readonly aliases?: Record<string, string>;
  readonly resolveUnknown?: UnknownModelResolver;
}

export type UnknownModelResolver = (modelId: string) => AgentModel | undefined;

export class StaticModelRegistry implements ModelRegistry {
  readonly #models: Map<string, AgentModel>;
  readonly #aliases: Readonly<Record<string, string>>;
  readonly #resolveUnknown: UnknownModelResolver | undefined;

  constructor(options: StaticModelRegistryOptions) {
    this.#models = new Map(options.entries.map((entry) => [entry.id, entry]));
    this.#aliases = { ...(options.aliases ?? {}) };
    this.#resolveUnknown = options.resolveUnknown;
    for (const [alias, target] of Object.entries(this.#aliases)) {
      if (!this.#models.has(target) && !this.#resolveUnknown?.(target)) {
        throw new Agent2APIError({
          code: "invalid_request",
          message: `Model alias '${alias}' refers to unknown model '${target}'`
        });
      }
    }
  }

  resolve(modelId: string): AgentModelTarget {
    return this.get(modelId).target;
  }

  get(modelId: string): AgentModel {
    const canonicalId = this.#aliases[modelId] ?? modelId;
    const model = this.#models.get(canonicalId) ?? this.#resolveUnknown?.(canonicalId);
    if (!model) {
      throw new Agent2APIError({
        code: "model_not_found",
        message: `Model '${modelId}' was not found`,
        param: "model"
      });
    }
    return model;
  }

  list(): AgentModel[] {
    return [...this.#models.values()];
  }
}
