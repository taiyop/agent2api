import {
  AGENT_IDS,
  DEFAULT_MODEL_ID,
  getAvailableModels,
  getAvailableReasoningEffortOptions,
  ModelAvailabilityError
} from "@headless-core/core";
import type { AgentExecutionRequest } from "../backend.js";
import type { AgentModel } from "../../core/types.js";
import { agentsWithoutEffort } from "./transports.js";

export interface HeadlessAgentSpec {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export function mapAgentSpec(request: Pick<AgentExecutionRequest, "target" | "reasoning">): HeadlessAgentSpec {
  return {
    provider: request.target.agent,
    model: request.target.model,
    ...(request.reasoning?.effort ? { reasoningEffort: request.reasoning.effort } : {})
  };
}

const HEADLESS_AGENT_IDS = new Set<string>(AGENT_IDS);
const HEADLESS_REASONING_EFFORTS = new Set<string>(
  AGENT_IDS.flatMap((agent) => getAvailableReasoningEffortOptions({ agent }))
);

export interface HeadlessCoreModelOptions {
  /**
   * Agents whose models accept no `reasoning.effort`. Defaults to how they run on their CLIs: Agy
   * and Mistral Vibe. A server whose Mistral runs on ACP leaves Mistral out.
   */
  readonly withoutEffort?: ReadonlySet<string>;
}

const CLI_WITHOUT_EFFORT = agentsWithoutEffort();

export function resolveHeadlessCoreModel(modelId: string, options: HeadlessCoreModelOptions = {}): AgentModel | undefined {
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) return undefined;
  const agent = modelId.slice(0, separator);
  const modelAndEffort = modelId.slice(separator + 1);
  const effortSeparator = modelAndEffort.lastIndexOf("/");
  const possibleEffort = effortSeparator > 0 ? modelAndEffort.slice(effortSeparator + 1) : undefined;
  const hasEffortSuffix = possibleEffort !== undefined && HEADLESS_REASONING_EFFORTS.has(possibleEffort);
  const model = hasEffortSuffix ? modelAndEffort.slice(0, effortSeparator) : modelAndEffort;
  const effort = hasEffortSuffix && possibleEffort !== "default" ? possibleEffort : undefined;
  if (
    !HEADLESS_AGENT_IDS.has(agent)
    || model.length === 0
    || model.startsWith("/")
    || model.endsWith("/")
    || model.trim() !== model
    || /\s/.test(model)
  ) return undefined;
  return {
    id: modelId,
    target: { backend: "headless-core", agent, model },
    ...(effort ? { defaultReasoning: { effort } } : {}),
    ownedBy: "agent2api",
    ...((options.withoutEffort ?? CLI_WITHOUT_EFFORT).has(agent) ? { capabilities: { reasoningEffort: false } } : {})
  };
}

/**
 * Lists the model candidates in headless_core's models.json (`~/.config/headless-core/models.json`,
 * or `HEADLESS_CORE_MODELS_PATH`) as `<agent>/<model>` IDs. Agents with no candidates beyond
 * `default` are left out, and a missing file lists nothing. The file is read on every call, so
 * edits show up without a restart.
 */
export async function discoverHeadlessCoreModels(options: HeadlessCoreModelOptions = {}): Promise<AgentModel[]> {
  const models: AgentModel[] = [];
  for (const agent of AGENT_IDS) {
    let candidates: string[];
    try {
      candidates = await getAvailableModels({ agent });
    } catch (error) {
      if (error instanceof ModelAvailabilityError && error.code === "MODELS_CONFIG_NOT_FOUND") return [];
      throw error;
    }
    if (!candidates.some((model) => model !== DEFAULT_MODEL_ID)) continue;
    for (const candidate of candidates) {
      const model = resolveHeadlessCoreModel(`${agent}/${candidate}`, options);
      if (model) models.push(model);
    }
  }
  return models;
}

/**
 * The `<id>/<effort>` forms of a headless-core model, one per effort headless_core recognizes for its
 * Agent (except `default`). Models that already carry an effort, or whose Agent takes no effort
 * (Agy, and Mistral Vibe on its CLI), have none. Whether a given model accepts an effort is still up to the Agent.
 */
export function headlessCoreEffortVariants(model: AgentModel): AgentModel[] {
  if (model.target.backend !== "headless-core" || model.defaultReasoning || model.capabilities?.reasoningEffort === false) return [];
  if (!HEADLESS_AGENT_IDS.has(model.target.agent)) return [];
  const base = `${model.target.agent}/${model.target.model}`;
  if (model.id !== base) return [];
  return getAvailableReasoningEffortOptions({ agent: model.target.agent })
    .filter((effort) => effort !== "default")
    .flatMap((effort) => resolveHeadlessCoreModel(`${base}/${effort}`) ?? []);
}
