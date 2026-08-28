import { contentText } from "./messages.js";
import type { AgentMessage } from "./types.js";

export interface PromptRenderer {
  render(messages: AgentMessage[]): string;
}

const ROLE_LABELS: Record<AgentMessage["role"], string> = {
  system: "SYSTEM",
  developer: "DEVELOPER",
  user: "USER",
  assistant: "ASSISTANT"
};

export class LabeledPromptRenderer implements PromptRenderer {
  render(messages: AgentMessage[]): string {
    return messages
      .map((message) => `[${ROLE_LABELS[message.role]}]\n${contentText(message.content)}`)
      .join("\n\n");
  }
}
