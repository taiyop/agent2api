import { Agent2APIError } from "./errors.js";
import type { AgentContent, AgentMessage } from "./types.js";

export function textContent(text: string): AgentContent {
  return { type: "text", text };
}

export function contentText(content: AgentContent[]): string {
  return content.map((item) => item.text).join("");
}

export function validateMessages(messages: AgentMessage[]): void {
  if (messages.length === 0) {
    throw new Agent2APIError({ code: "invalid_request", message: "messages must not be empty", param: "messages" });
  }
  for (const message of messages) {
    if (message.content.length === 0) {
      throw new Agent2APIError({ code: "invalid_request", message: "message content must not be empty", param: "messages" });
    }
  }
}
