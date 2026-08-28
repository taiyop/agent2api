import type { AgentCapabilities } from "./types.js";

export const TEXT_AGENT_CAPABILITIES: AgentCapabilities = Object.freeze({
  textInput: true,
  textOutput: true,
  streaming: true,
  reasoningEffort: true,
  externalTools: false,
  imageInput: false,
  audioInput: false,
  fileInput: false
});

export function intersectCapabilities(...items: AgentCapabilities[]): AgentCapabilities {
  const [first, ...rest] = items;
  if (!first) {
    throw new Error("At least one capability set is required");
  }
  const result = { ...first };
  for (const item of rest) {
    for (const key of Object.keys(result) as (keyof AgentCapabilities)[]) {
      result[key] = result[key] && item[key];
    }
  }
  return result;
}
