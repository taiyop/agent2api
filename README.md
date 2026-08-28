# Agent2API

Expose authenticated local AI Agents through familiar LLM API interfaces.

Agent2API is an application host for local Agent APIs. It mounts [`llm-mimic-surface`](https://github.com/taiyop/llm-mimic-surface) on its HTTP server, adapts the protocol-neutral request to the Agent2API core, resolves an Agent/model target, renders the complete message history as a deterministic prompt, and delegates execution to [`@headless-core/core`](https://github.com/taiyop/headless_core).

```text
OpenAI SDK
    │
    ▼
Agent2API
    │
    ▼
headless_core
    │
    ▼
Authenticated local Agent CLI
```

Agent2API never logs in to an Agent, reads credentials, refreshes tokens, or implements a provider API client. The selected Codex, Claude Code, Grok, or Agy CLI must already be installed and authenticated by the user.

## Architecture

```text
OpenAI / Anthropic / Gemini / Custom API
                  │
                  ▼
          Agent2API HTTP Host
                  │
                  ▼
        LLMMimicSurface Plugin
                  │
                  ▼
      Agent2API Backend Adapter
                  │
                  ▼
      Canonical Agent IR + Runner
                  │
                  ▼
          Pluggable Agent Backend
                  │
                  ▼
         HeadlessCore Adapter
                  │
                  ▼
       Authenticated Agent CLI
```

The dependency direction is intentional:

```text
server ─────→ llm-mimic-surface
  │
  └────→ Agent2API Backend Adapter ─────→ core ←───── backends/*
```

- `core` has no OpenAI, Fastify, or headless_core dependency.
- `llm-mimic-surface` has no headless_core dependency.
- `backends/headless-core` has no OpenAI dependency.
- Chat Completions and Responses use the same Canonical request and backend path.

Agent2API owns the Fastify instance, authentication, logging, configuration, listen address, and lifecycle. LLMMimicSurface registers the external protocol routes and owns their HTTP/SSE wire formats.

## Requirements

- Node.js 20 or newer
- npm
- At least one supported Agent CLI installed and already authenticated

Agent2API does not require an Agent provider API key. A dummy key is sufficient for OpenAI SDK clients unless optional HTTP access authentication is enabled.

## Install and run

The package is publish-ready but is not yet published to the npm registry. Run it from a source
checkout:

```bash
npm install
npm run build
node dist/cli/main.js serve --config ./examples/agent2api.config.json
```

After the package is published, global installation will be:

```bash
npm install -g agent2api
agent2api serve --config ./agent2api.config.json
```

The default bind address is `127.0.0.1:8080`. A minimal config is:

```json
{
  "backends": {
    "headless-core": {
      "cwd": ".",
      "timeoutMs": 120000
    }
  }
}
```

`cwd`, timeout, model routing, and HTTP access settings are server configuration only. API request bodies cannot select a working directory, environment, binary path, CLI argument, or shell command.

## OpenAI-compatible API

Implemented endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /health`

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8080/v1"
});

const completion = await client.chat.completions.create({
  model: "codex/default",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" }
  ]
});

console.log(completion.choices[0]?.message.content);
```

Responses API:

```ts
const response = await client.responses.create({
  model: "codex/default",
  input: "Explain this repository in one sentence."
});
```

Both endpoints support the request field `stream: true` over SSE (`streaming: true` is not the
OpenAI-compatible field). Because headless_core progress can contain process state, stdout, or
stderr, it is never exposed as assistant text. The current implementation is completion-buffered
streaming: it opens the SSE connection immediately, sends heartbeat comments while the Agent runs,
then emits the final returned output as one text delta, a finish event, and `[DONE]`. It does not
reduce time-to-first-text compared with a non-streaming request. Client disconnects propagate
through `AbortSignal` to headless_core.

For streaming requests, HTTP `200 OK` means that the SSE connection was established, not that Agent
execution succeeded. A model-resolution or execution failure discovered afterward is sent as an SSE
error event followed by `[DONE]`. True incremental text streaming can be added when a backend exposes
a semantically safe assistant-output event such as `output.delta`; raw progress/stdout/stderr will
not be treated as assistant output.

## Models and aliases

Canonical model IDs use `<agent>/<model>`:

- `codex/default`
- `claude/default`, `claude/sonnet`, `claude/opus`, `claude/haiku`
- `grok/default`
- `agy/default`

An optional final reasoning-effort suffix is also supported:

```text
<agent>/<model>/<effort>
codex/gpt-5.6-luna/low
```

The recognized suffix vocabulary comes from headless_core: `default`, `low`, `medium`, `high`,
`xhigh`, and `max`. Individual Agents do not necessarily support every value; actual acceptance is
delegated to the selected backend/CLI. A suffix of `default`, or omitting the suffix entirely, leaves
reasoning effort unspecified. If the request body also contains `reasoning.effort`, the explicit body
value takes precedence. Recognized effort words in the final path segment are reserved and are
removed from the model name before execution.

Agy exposes Gemini and other models through model slugs that may already contain an effort tier. Use
the whole slug as the model portion:

```text
agy/gemini-3.7-flash-low    # correct: Agy model slug
agy/gemini-3.7-flash/low    # rejected: generic effort suffix is not supported for Agy
gemini/gemini-3.7-flash     # rejected: `gemini` is not a HeadlessCore Agent provider
```

This is Gemini-model execution through the authenticated Agy CLI. It does not add a Gemini external
protocol adapter or a direct Gemini API connection.

`model: "default"` remains unchanged when sent to headless_core, so the CLI's own default model is used without a provider model flag.

Models are resolved by `ModelRegistry`, not by the OpenAI adapter. Explicit `models.entries` are
optional: an unregistered canonical ID such as `codex/gpt-5.6-luna` is dynamically routed to the
HeadlessCore backend, and headless_core/the authenticated CLI determines whether it is actually
available. The `/v1/models` response remains a discoverable catalog of configured/default entries;
it is not an exhaustive list of every model a local CLI may accept.

Aliases are also optional and may point directly to a dynamic canonical ID:

```json
{
  "models": {
    "aliases": {
      "default": "codex/default",
      "smart": "claude/opus",
      "luna": "codex/gpt-5.6-luna",
      "luna-low": "codex/gpt-5.6-luna/low"
    }
  }
}
```

## Reasoning effort

The OpenAI request field is decoded into Canonical IR first:

```json
{
  "model": "codex/default",
  "reasoning": { "effort": "high" }
}
```

The HeadlessCore backend later forwards the canonical effort to `headless.run()`. Capability
validation rejects reasoning on a model/Agent that does not support it. In the current HeadlessCore
adapter, Agy does not accept the generic `reasoning.effort` field; choose an Agy model slug such as
`gemini-3.7-flash-low` instead.

## Optional HTTP access authentication

This protects `Client → Agent2API`. It is unrelated to Agent CLI authentication.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "auth": { "bearerToken": "local-secret" }
  }
}
```

Clients then send `Authorization: Bearer local-secret`. `/health` remains unauthenticated. Do not bind to a non-loopback interface without appropriate host/network controls and an HTTP bearer token.

## Logging

Requests are logged as structured records containing request ID, protocol, resolved model, backend,
Agent, duration, and status. Prompt text, Agent output, authentication information, and environment
variables are not logged by default. Ignored compatibility parameters are logged by parameter name
only, never by value.

## Unsupported in the MVP

Agent2API explicitly returns `unsupported_feature` instead of silently dropping unsupported input:

- OpenAI external tools, `tool_calls`, and parallel tool calls
- image, audio, and file input
- embeddings, image generation, and audio generation
- `previous_response_id` and persistent conversations
- remote MCP

An Agent CLI may use its own internal tools. That does not expose OpenAI tool calling to an API client.

Unknown compatibility parameters that do not select one of these explicit features—such as
`temperature`, `top_p`, or a client-specific extension—are accepted by the external protocol
surface where compatible and are not forwarded as execution controls to headless_core. Explicit
tools, unsupported media, files, and persistent-conversation features remain rejected.

## Responsibility boundary

`headless_core`:

- runs local AI Agent CLIs
- owns provider-specific CLI arguments
- owns timeout and abort process handling
- maps reasoning effort
- handles model candidates
- classifies execution failures

`llm-mimic-surface`:

- registers OpenAI-compatible routes on the Agent2API Fastify host
- parses external requests into its protocol-neutral boundary contract
- serializes HTTP responses, API errors, and SSE events
- propagates client disconnects through `AbortSignal`

Agent2API:

- owns the HTTP server, authentication, logging, configuration, and lifecycle
- registers LLMMimicSurface on that server
- defines Canonical Agent IR and events
- resolves configured models and aliases
- converts full message history into a prompt
- converts responses and streaming events
- normalizes API-level errors

Agent2API does not implement authentication/OAuth for Agent CLIs, credential storage or rotation, direct AI Provider API calls, billing, a database, persistent conversations, a web UI, Agent logic, or CLI process spawning.

## Development

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The normal test suite uses `FakeAgentBackend`; Codex, Claude Code, Grok, and Agy are not required in CI. Real-Agent E2E tests, if added, should be opt-in with `AGENT2API_E2E=1`.

## License

MIT
