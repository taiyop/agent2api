import { describe, expect, it } from "vitest";
import { LabeledPromptRenderer } from "../../src/core/promptRenderer.js";

describe("LabeledPromptRenderer", () => {
  it("renders the complete conversation deterministically", () => {
    const renderer = new LabeledPromptRenderer();
    expect(
      renderer.render([
        { role: "system", content: [{ type: "text", text: "You are helpful." }] },
        { role: "developer", content: [{ type: "text", text: "Follow conventions." }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] }
      ])
    ).toBe(
      "[SYSTEM]\nYou are helpful.\n\n[DEVELOPER]\nFollow conventions.\n\n[USER]\nHello\n\n[ASSISTANT]\nHi\n\n[USER]\nContinue"
    );
  });
});
