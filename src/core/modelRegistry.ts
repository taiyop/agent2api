import { Agent2APIError } from "./errors.js";
import type { AgentModel, AgentModelTarget } from "./types.js";

export interface ModelRegistry {
  resolve(modelId: string): AgentModelTarget;
  get(modelId: string): AgentModel;
  list(): AgentModel[];
  /**
   * Everything a client can pick: the aliases, then each Agent's models (configured, alias targets,
   * and discovered at request time), each followed by its variants. Deduplicated by id.
   */
  listAvailable(): Promise<AgentModel[]>;
}

export interface StaticModelRegistryOptions {
  readonly entries: AgentModel[];
  readonly aliases?: Record<string, string>;
  readonly resolveUnknown?: UnknownModelResolver;
  /** Lists further models each time the model list is requested, such as headless_core's models.json. */
  readonly discover?: ModelDiscovery;
  /** Further IDs listed right after a model, such as its `<id>/<effort>` forms. */
  readonly variants?: ModelVariants;
}

export type UnknownModelResolver = (modelId: string) => AgentModel | undefined;
export type ModelDiscovery = () => Promise<AgentModel[]>;
export type ModelVariants = (model: AgentModel) => AgentModel[];

export class StaticModelRegistry implements ModelRegistry {
  readonly #models: Map<string, AgentModel>;
  readonly #aliases: Readonly<Record<string, string>>;
  readonly #resolveUnknown: UnknownModelResolver | undefined;
  readonly #discover: ModelDiscovery | undefined;
  readonly #variants: ModelVariants | undefined;

  constructor(options: StaticModelRegistryOptions) {
    this.#models = new Map(options.entries.map((entry) => [entry.id, entry]));
    this.#aliases = { ...(options.aliases ?? {}) };
    this.#resolveUnknown = options.resolveUnknown;
    this.#discover = options.discover;
    this.#variants = options.variants;
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

  async listAvailable(): Promise<AgentModel[]> {
    const aliases = Object.keys(this.#aliases).map((alias) => ({ ...this.get(alias), id: alias }));
    const aliasTargets = Object.values(this.#aliases).map((target) => this.get(target));
    const discovered = this.#discover ? await this.#discover() : [];
    const seen = new Set<string>();
    const fresh = (model: AgentModel) => !seen.has(model.id) && Boolean(seen.add(model.id));
    const models = [...this.list(), ...aliasTargets, ...discovered].filter(fresh);
    // Keep each Agent's models together, in the order the Agents first appear.
    const agentOrder = [...new Set(models.map((model) => model.target.agent))];
    const grouped = models
      .map((model, index) => ({ model, index, agent: agentOrder.indexOf(model.target.agent) }))
      .sort((a, b) => a.agent - b.agent || a.index - b.index)
      .map(({ model }) => model);
    // A model that is also another model's variant (an alias to `codex/x/low`) is listed in that slot.
    const variantsOf = new Map(grouped.map((model) => [model.id, this.#variants?.(model) ?? []]));
    const variantIds = new Set([...variantsOf.values()].flat().map((model) => model.id));
    const listed = new Set<string>();
    const once = (model: AgentModel) => !listed.has(model.id) && Boolean(listed.add(model.id));
    const expanded = grouped
      .filter((model) => !variantIds.has(model.id))
      .flatMap((model) => [model, ...(variantsOf.get(model.id) ?? [])]);
    return [...aliases, ...expanded].filter(once);
  }

}
