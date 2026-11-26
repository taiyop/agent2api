import { createHash } from "node:crypto";
import type { AgentSession } from "../backends/backend.js";
import { contentText } from "./messages.js";
import type { AgentMessage } from "./types.js";

export interface ConversationStoreOptions {
  /** Kept conversations unused for this long are closed. */
  readonly idleTimeoutMs: number;
  /** At most this many conversations are kept; the least recently used one is closed first. */
  readonly maxConversations: number;
  /** At most this many responses are remembered for `previous_response_id`. */
  readonly maxResponses?: number;
  readonly now?: () => number;
}

interface KeptConversation {
  readonly session: AgentSession;
  lastUsed: number;
}

/**
 * Holds the conversations Agents keep open, keyed by the history they hold, and the transcripts of
 * recent responses for `previous_response_id`.
 *
 * A conversation is found by its history, not by an ID, so a client that sends the full history on
 * every request (as OpenAI clients do) continues its conversation without knowing about it, and
 * several conversations can be continued in any order. A conversation is taken out while a turn
 * runs, so two requests never share one; the second one starts a new conversation instead.
 */
export class ConversationStore {
  readonly #options: Required<Omit<ConversationStoreOptions, "now">>;
  readonly #now: () => number;
  /** Insertion order is the order of last use. */
  readonly #conversations = new Map<string, KeptConversation>();
  readonly #responses = new Map<string, AgentMessage[]>();
  readonly #sweeper: NodeJS.Timeout | undefined;

  constructor(options: ConversationStoreOptions) {
    this.#options = {
      idleTimeoutMs: options.idleTimeoutMs,
      maxConversations: options.maxConversations,
      maxResponses: options.maxResponses ?? 1_000
    };
    this.#now = options.now ?? Date.now;
    if (this.#options.maxConversations > 0) {
      this.#sweeper = setInterval(() => this.sweep(), Math.min(this.#options.idleTimeoutMs, 60_000));
      this.#sweeper.unref();
    }
  }

  get size(): number {
    return this.#conversations.size;
  }

  /** Takes out the conversation whose history is `key`, if one is kept and still usable. */
  take(key: string): AgentSession | undefined {
    const kept = this.#conversations.get(key);
    if (!kept) return undefined;
    this.#conversations.delete(key);
    if (!kept.session.alive || this.#expired(kept)) {
      void kept.session.close();
      return undefined;
    }
    return kept.session;
  }

  /** Keeps a conversation whose history is now `key`. Closes it instead when nothing may be kept. */
  keep(key: string, session: AgentSession): void {
    if (!session.alive || this.#options.maxConversations === 0) {
      void session.close();
      return;
    }
    const previous = this.#conversations.get(key);
    if (previous && previous.session !== session) void previous.session.close();
    this.#conversations.delete(key);
    this.#conversations.set(key, { session, lastUsed: this.#now() });
    while (this.#conversations.size > this.#options.maxConversations) {
      const [oldestKey, oldest] = this.#conversations.entries().next().value as [string, KeptConversation];
      this.#conversations.delete(oldestKey);
      void oldest.session.close();
    }
  }

  recordResponse(id: string, transcript: AgentMessage[]): void {
    this.#responses.delete(id);
    this.#responses.set(id, transcript);
    while (this.#responses.size > this.#options.maxResponses) {
      this.#responses.delete(this.#responses.keys().next().value as string);
    }
  }

  /** The full history up to and including the response, or undefined when it is not remembered. */
  response(id: string): AgentMessage[] | undefined {
    return this.#responses.get(id);
  }

  /** Closes conversations that have been idle too long. */
  sweep(): void {
    for (const [key, kept] of this.#conversations) {
      if (kept.session.alive && !this.#expired(kept)) continue;
      this.#conversations.delete(key);
      void kept.session.close();
    }
  }

  async close(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper);
    const sessions = [...this.#conversations.values()].map((kept) => kept.session);
    this.#conversations.clear();
    this.#responses.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }

  #expired(kept: KeptConversation): boolean {
    return this.#now() - kept.lastUsed > this.#options.idleTimeoutMs;
  }
}

/**
 * Identifies a conversation history on a model. Whitespace at the ends of each message and line
 * ending styles are ignored, since clients often trim the text they send back.
 */
export function conversationKey(modelId: string, effort: string | undefined, messages: readonly AgentMessage[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([modelId, effort ?? null]));
  for (const message of messages) {
    hash.update("\u0000");
    hash.update(message.role);
    hash.update("\u0001");
    hash.update(contentText(message.content).replace(/\r\n?/g, "\n").trim());
  }
  return hash.digest("hex");
}
