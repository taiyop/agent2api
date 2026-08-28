import { once } from "node:events";
import type { FastifyReply } from "fastify";
import { encodeSse, type EncodedSseEvent } from "../../protocols/openai/streamCodec.js";

export class SseWriter {
  readonly #raw: FastifyReply["raw"];
  readonly #heartbeat: NodeJS.Timeout | undefined;

  constructor(reply: FastifyReply, heartbeatIntervalMs = 15_000) {
    reply.hijack();
    this.#raw = reply.raw;
    this.#raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    this.#raw.flushHeaders();
    this.#heartbeat = heartbeatIntervalMs > 0
      ? setInterval(() => {
          if (!this.#raw.destroyed) this.#raw.write(": heartbeat\n\n");
        }, heartbeatIntervalMs)
      : undefined;
    this.#heartbeat?.unref();
  }

  async write(event: EncodedSseEvent): Promise<void> {
    if (this.#raw.destroyed || this.#raw.writableEnded) return;
    if (!this.#raw.write(encodeSse(event))) await once(this.#raw, "drain");
  }

  async done(): Promise<void> {
    await this.write({ data: "[DONE]" });
  }

  end(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (!this.#raw.writableEnded) this.#raw.end();
  }
}
