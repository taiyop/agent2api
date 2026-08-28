import type { AgentModel } from "../../core/types.js";

export function encodeModels(models: AgentModel[]): Record<string, unknown> {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.ownedBy ?? "agent2api"
    }))
  };
}
