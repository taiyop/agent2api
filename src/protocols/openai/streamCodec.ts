export interface EncodedSseEvent {
  readonly event?: string;
  readonly data: string;
}

export function encodeSse(event: EncodedSseEvent): string {
  return `${event.event ? `event: ${event.event}\n` : ""}data: ${event.data}\n\n`;
}

export function chatChunk(input: {
  id: string;
  model: string;
  created: number;
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: Record<string, number> | null;
}): EncodedSseEvent {
  return {
    data: JSON.stringify({
      id: input.id,
      object: "chat.completion.chunk",
      created: input.created,
      model: input.model,
      choices: input.usage ? [] : [{ index: 0, delta: input.delta ?? {}, finish_reason: input.finishReason ?? null }],
      ...(input.usage ? { usage: input.usage } : {})
    })
  };
}

export function responsesEvent(type: string, data: Record<string, unknown>): EncodedSseEvent {
  return { event: type, data: JSON.stringify({ type, ...data }) };
}
