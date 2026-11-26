import { AGENT_IDS, getAvailableReasoningEffortOptions } from "@headless-core/core";
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
