import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function registerBearerAuth(server: FastifyInstance, expectedToken: string): void {
  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token || !safeEqual(token, expectedToken)) {
      await reply.status(401).send({
        error: {
          message: "Invalid or missing Agent2API bearer token",
          type: "authentication_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }
  });
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
