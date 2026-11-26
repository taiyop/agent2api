import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentBackend, type FakeAgentSession } from "../../src/backends/fake.js";
import { parseConfig } from "../../src/config/schema.js";
import { Agent2APIError } from "../../src/core/errors.js";
import { createServer } from "../../src/transport/http/server.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function start(backend: FakeAgentBackend, sessions: Record<string, unknown> = {}) {
  const config = parseConfig({
    server: { logging: false },
    sessions,
    models: {
      entries: [
        { id: "codex/default", backend: "fake", agent: "codex", model: "default" },
        { id: "claude/default", backend: "fake", agent: "claude", model: "default" }
      ]
    }
  });
  const server = createServer(config, { backends: [backend] });
  servers.push(server);
  return server;
}

/** Replies with the turn number within its conversation, such as "s1-t2". */
function numbered() {
  return new FakeAgentBackend({
    sessions: true,
    reply: (_prompt, session) => `s${backendSessions.indexOf(session) + 1}-t${session.prompts.length}`
  });
}
let backendSessions: FakeAgentSession[] = [];

type Message = { role: string; content: string };

async function chat(server: ReturnType<typeof createServer>, messages: Message[], headers: Record<string, string> = {}, model = "codex/default") {
  const response = await server.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model, messages } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().choices[0].message.content as string;
}

async function respond(server: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  return server.inject({ method: "POST", url: "/v1/responses", payload: { model: "codex/default", ...body } });
}

describe("kept conversations", () => {
  it("continues a Chat Completions conversation by sending only the new messages", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    const history: Message[] = [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }];
    const first = await chat(server, history);
    expect(first).toBe("s1-t1");
    expect(backend.sessions[0]!.prompts[0]).toBe("[SYSTEM]\nBe brief.\n\n[USER]\nhi");

    history.push({ role: "assistant", content: first }, { role: "user", content: "and?" });
    expect(await chat(server, history)).toBe("s1-t2");
    expect(backend.sessions).toHaveLength(1);
    expect(backend.sessions[0]!.prompts[1]).toBe("[USER]\nand?");
    expect(backend.requests).toHaveLength(0);
  });

  it("keeps several conversations apart when their turns alternate", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    const a: Message[] = [{ role: "user", content: "topic A" }];
    const b: Message[] = [{ role: "user", content: "topic B" }];
    a.push({ role: "assistant", content: await chat(server, a) }, { role: "user", content: "more A" });
    b.push({ role: "assistant", content: await chat(server, b) }, { role: "user", content: "more B" });
    expect(await chat(server, a)).toBe("s1-t2");
    expect(await chat(server, b)).toBe("s2-t2");
    expect(backend.sessions.map((session) => session.prompts)).toEqual([
      ["[USER]\ntopic A", "[USER]\nmore A"],
      ["[USER]\ntopic B", "[USER]\nmore B"]
    ]);
  });

  it("starts over when the client edits the history, changes the model, or asks for a new conversation", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    const first = await chat(server, [{ role: "user", content: "hi" }]);

    // A regenerated or edited reply no longer matches what the kept conversation holds.
    await chat(server, [{ role: "user", content: "hi" }, { role: "assistant", content: "edited" }, { role: "user", content: "x" }]);
    expect(backend.sessions).toHaveLength(2);
    expect(backend.sessions[1]!.prompts[0]).toBe("[USER]\nhi\n\n[ASSISTANT]\nedited\n\n[USER]\nx");

    const continued: Message[] = [{ role: "user", content: "hi" }, { role: "assistant", content: first }, { role: "user", content: "y" }];
    await chat(server, continued, {}, "claude/default");
    expect(backend.sessions).toHaveLength(3);

    await chat(server, continued, { "x-agent2api-conversation": "new" });
    expect(backend.sessions).toHaveLength(4);
    expect(backend.sessions[3]!.prompts[0]).toContain("[USER]\nhi");
    // The first conversation was never taken, so it can still continue.
    expect(await chat(server, continued)).toBe("s1-t2");
  });

  it("rejects an unknown conversation header value", async () => {
    const server = start(numbered());
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-agent2api-conversation": "sometimes" },
      payload: { model: "codex/default", messages: [{ role: "user", content: "hi" }] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("'auto' or 'new'");
  });

  it("continues a Responses conversation from previous_response_id, including a branch from an older response", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    const first = (await respond(server, { instructions: "Be brief.", input: "hi" })).json();
    expect(first.output[0].content[0].text).toBe("s1-t1");

    const second = (await respond(server, { instructions: "Be brief.", input: "next", previous_response_id: first.id })).json();
    expect(second.output[0].content[0].text).toBe("s1-t2");
    // Repeated instructions are not sent again, and the id is not mixed into them.
    expect(backend.sessions[0]!.prompts[1]).toBe("[USER]\nnext");

    // The kept conversation has moved on, so branching from the first response replays its history.
    const branch = (await respond(server, { input: "other", previous_response_id: first.id })).json();
    expect(branch.output[0].content[0].text).toBe("s2-t1");
    expect(backend.sessions[1]!.prompts[0]).toBe("[SYSTEM]\nBe brief.\n\n[USER]\nhi\n\n[ASSISTANT]\ns1-t1\n\n[USER]\nother");

    const missing = await respond(server, { input: "x", previous_response_id: "resp_unknown" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain("resp_unknown");
  });

  it("uses the same response id when streaming, so the OpenAI SDK can continue from it", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = new OpenAI({ apiKey: "dummy", baseURL: `http://127.0.0.1:${address.port}/v1` });

    let id: string | undefined;
    for await (const event of await client.responses.create({ model: "codex/default", input: "hi", stream: true })) {
      if (event.type === "response.completed") id = event.response.id;
    }
    expect(id).toMatch(/^a2a_/);
    const next = await client.responses.create({ model: "codex/default", input: "next", previous_response_id: id! });
    expect(next.output_text).toBe("s1-t2");
  });

  it("keeps nothing for store: false", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend);
    const first = (await respond(server, { input: "hi", store: false })).json();
    expect(backend.sessions[0]!.alive).toBe(false);
    expect((await respond(server, { input: "x", previous_response_id: first.id })).statusCode).toBe(400);
  });

  it("starts over with the full history when a kept conversation broke", async () => {
    let broken = false;
    const backend = new FakeAgentBackend({
      sessions: true,
      reply: (_prompt, session) => {
        if (broken && session === backend.sessions[0]) {
          throw new Agent2APIError({ code: "backend_unavailable", message: "Agent process exited" });
        }
        return "ok";
      }
    });
    const server = start(backend);
    await chat(server, [{ role: "user", content: "hi" }]);
    broken = true;
    expect(await chat(server, [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "again" }])).toBe("ok");
    expect(backend.sessions).toHaveLength(2);
    expect(backend.sessions[1]!.prompts[0]).toBe("[USER]\nhi\n\n[ASSISTANT]\nok\n\n[USER]\nagain");
  });

  it("closes the least recently used conversation beyond maxConversations", async () => {
    const backend = numbered();
    backendSessions = backend.sessions;
    const server = start(backend, { maxConversations: 1 });
    await chat(server, [{ role: "user", content: "a" }]);
    await chat(server, [{ role: "user", content: "b" }]);
    expect(backend.sessions.map((session) => session.alive)).toEqual([false, true]);
  });

  it("runs every request on its own when sessions are off, but still follows previous_response_id", async () => {
    const backend = new FakeAgentBackend({ sessions: true, output: "ok" });
    const server = start(backend, { enabled: false });
    await chat(server, [{ role: "user", content: "hi" }]);
    await chat(server, [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "x" }]);
    expect(backend.sessions).toHaveLength(0);
    expect(backend.requests.map((request) => request.prompt)).toEqual(["[USER]\nhi", "[USER]\nhi\n\n[ASSISTANT]\nok\n\n[USER]\nx"]);

    const first = (await respond(server, { input: "one" })).json();
    await respond(server, { input: "two", previous_response_id: first.id });
    expect(backend.requests.at(-1)!.prompt).toBe("[USER]\none\n\n[ASSISTANT]\nok\n\n[USER]\ntwo");
  });
});
