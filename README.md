# Agent2API

English | [日本語](README.ja.md)

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

Agent2API never logs in to an Agent, reads credentials, refreshes tokens, or implements a provider API client. The selected Codex, Claude Code, Grok, Agy, Devin, or Mistral Vibe CLI must already be installed and authenticated by the user.

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
- macOS or Linux. On Windows, run Agent2API inside WSL2 (see [Windows (WSL2)](#windows-wsl2)).
- On Linux (including WSL2), `bwrap`, `socat`, and `rg` for the [sandbox](#sandbox), which is on by default:
  `sudo apt install bubblewrap socat ripgrep`

Agent2API does not require an Agent provider API key. A dummy key is sufficient for OpenAI SDK clients unless optional HTTP access authentication is enabled.

## Install and run

The package is publish-ready but is not yet published to the npm registry. Run it from a source
checkout:

```bash
npm install
npm run build
node dist/cli/main.js serve --config ./examples/agent2api.config.json
```

`npm start` builds and starts the server with the example config. To use another config file, run `npm run serve -- --config ./my.config.json`.

During development, if [Bun](https://bun.sh) is installed, `npm run dev` runs the TypeScript sources directly without a build. It does not type-check, so also run `npm run typecheck`.

After the package is published, global installation will be:

```bash
npm install -g agent2api
agent2api serve --config ./agent2api.config.json
```

The default bind address is `127.0.0.1:8080`. If that port is taken, set `server.port` in the config or
pass `--port`, which overrides the config (`agent2api serve --config ./agent2api.config.json --port 8090`).
A minimal config is:

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

With this config the Agent CLIs run inside the [sandbox](#sandbox), which is on by default.

`cwd`, timeout, sandbox, model routing, and HTTP access settings are server configuration only. API request bodies cannot select a working directory, environment, binary path, CLI argument, or shell command.

## OpenAI-compatible API

Implemented endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /health`
- `GET /docs` (Swagger UI) and `GET /openapi.json`

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

## Conversations and running Agents

Agent2API keeps each Agent running between requests and keeps conversations open in it, so a
follow-up turn does not start the Agent again or send the whole history again. It uses the Agent's
persistent transport through headless_core: `codex app-server`, the Claude Agent SDK, or ACP
(Grok, Devin, Mistral Vibe). Agy stays on its CLI by default: its ACP server answered with its own
start-up errors and did not open a session inside the sandbox, so `acp` for Agy is opt-in. On this machine a codex follow-up took about 2 seconds instead of
6 to 8 over `codex exec`.

**Chat Completions** stays stateless for the client: send the full history in `messages` as usual.
When the history up to the last assistant message is a conversation Agent2API keeps open (same
model and effort), only the messages after it go to the Agent. Otherwise a new conversation starts
with the whole history. Several conversations can continue in any order. A regenerated or edited
reply, or a different model, starts a new conversation. To always start one, send:

```
X-Agent2API-Conversation: new
```

**Responses API**: `previous_response_id` continues from an earlier response, with only the new
input:

```ts
const first = await client.responses.create({ model: "codex/default", input: "Remember the word KIWI." });
const next = await client.responses.create({
  model: "codex/default",
  input: "Which word?",
  previous_response_id: first.id
});
```

Branching from an older response, or continuing after its conversation was closed, replays that
response's history in a new conversation. `store: false` keeps neither the conversation nor the
response. Responses are remembered in memory (the latest 1,000) and are lost on restart.

Even a new conversation is faster: Agent2API keeps one unused conversation ready for each Agent it
has used, opened like the last one, so the next request does not wait for the Agent to start.

```json
{
  "sessions": { "enabled": true, "idleTimeoutSeconds": 600, "maxConversations": 8 },
  "backends": {
    "headless-core": {
      "transports": { "grok": "cli" },
      "prewarm": ["codex", "claude"]
    }
  }
}
```

- `sessions.enabled` (default `true`): `false` runs every request with the Agent CLI as before.
  `previous_response_id` still works then, by replaying the history.
- `sessions.idleTimeoutSeconds` (default 600): a conversation, or a ready Agent, unused this long is
  closed, and the Agent process exits once nothing uses it.
- `sessions.maxConversations` (default 8): beyond this the least recently used conversation is
  closed. With the Claude Agent SDK every conversation is its own `claude` process, so keep this modest.
- `backends.headless-core.transports`: `"cli"` keeps an Agent on its CLI. The others are
  `app-server` (codex), `sdk` (claude), and `acp` (the rest; Agy defaults to `cli`).
- `backends.headless-core.prewarm`: Agents started with the server, so even the first request finds
  them running.

If an Agent's persistent transport cannot start (for example the optional
`@anthropic-ai/claude-agent-sdk` dependency is not installed), Agent2API logs a warning and runs that
Agent's CLI for the next 5 minutes. The same happens when it does not open a conversation within 60
seconds. A kept conversation whose Agent process exited is started over
with the full history. The sandbox applies to the persistent transports too.

Agent2API starts codex with `--disable hooks`: the user's codex hooks (`~/.codex/hooks.json`) are for
interactive use, and under `codex app-server` they can keep a turn from ever completing.

## API docs and AI Agent connection prompt

While the server is running, open `http://127.0.0.1:8080/docs` for Swagger UI. The OpenAPI 3.1
document is at `/openapi.json`, and it reflects the configured mount paths, models, aliases, and
whether bearer auth is enabled. The Swagger UI assets are served locally from `swagger-ui-dist`, so
the page works offline.

The top of the page has a connection prompt for AI agents (English or Japanese) with a **Copy
prompt** button. It contains the base URL, authentication, models, timeout, and unsupported
features, so you can paste it into an agent and have it call this server. When bearer auth is on, the
server never puts the token in the page; you can type it into the page to embed it in the copied
text, which happens only in your browser.

`/docs`, `/docs/assets/*`, and `/openapi.json` are public even when bearer auth is enabled, like
`/health`. To turn them off, set `"server": { "docs": false }`.

## Bench: check the API in a browser

A source checkout includes a small GUI for checking a running Agent2API server. Start Agent2API, then
in another terminal:

```bash
npm run bench -- --config ./examples/agent2api.config.json   # or: bun run bench -- --config ...
```

The bench listens on a free port that the OS picks, so it never conflicts; open the URL it prints. To
use a fixed port, pass `--port <n>` or set `BENCH_PORT`. A fixed port that is taken is an error. With a
fixed port, the page also remembers your form between runs; the browser keeps that per port.

The bench reads Agent2API's host, port, mount path, and bearer token from the config file; without
`--config` it targets `http://127.0.0.1:8080`. `--target <url>` overrides the address (use it when you
started Agent2API with `--port`), and `AGENT2API_TOKEN` supplies a token without a config file.

- **Status light**: `GET /health` every 5 seconds.
- **Models**: the `/v1/models` catalog; click one to use it.
- **Request**: send Chat Completions or Responses, with or without `stream: true`, a system message,
  and reasoning effort. It shows the reply, HTTP status, time to headers, time to first text, total
  time, keep-alive count, and the raw JSON or SSE events. Cancel aborts the run, and "Copy as curl"
  gives the same request for a terminal.
- **Smoke test**: sends one prompt to several models, in parallel or one by one, and marks each as
  pass, mismatch (the reply lacks the expected text), or fail.

The page talks only to the bench, which forwards `/health`, `/v1/models`, `/v1/chat/completions`, and
`/v1/responses` to Agent2API. The bench listens on `127.0.0.1` only, accepts requests only from its own
page, and adds the bearer token itself, so the token never reaches the browser.

## Models and aliases

Canonical model IDs use `<agent>/<model>`:

- `codex/default`
- `claude/default`, `claude/sonnet`, `claude/opus`, `claude/haiku`
- `grok/default`
- `agy/default`
- `mistral/default`

`GET /v1/models` also lists the model candidates in headless_core's models file,
`~/.config/headless-core/models.json` (or the path in `HEADLESS_CORE_MODELS_PATH`), as
`<agent>/<model>`. Each Agent with candidates also gets `<agent>/default`. Create the file with
`npx headless-core models init`. It is read on every request, so edits show up without a restart. A
missing file adds nothing; a broken one makes `/v1/models` return an error naming the file.

The list starts with your aliases, then groups the models by Agent. Each model that takes a reasoning
effort is followed by its effort forms, such as `codex/gpt-6-luna/low`, so clients that can only pick
a model ID can still choose an effort. Set `"models": {"listEffortVariants": false}` to list the plain
models only. The list is only a guide: any `<agent>/<model>[/<effort>]` ID can be requested, listed or
not.

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

Mistral Vibe (`vibe` 3.1 or later) is the `mistral` Agent. Its model portion is a Vibe model
**alias** from `~/.vibe/config.toml` (including your own aliases), not a Mistral API model name, and
`mistral/default` uses Vibe's active model. It runs on `vibe-acp` (or, with sessions off, on
`vibe --agent ask --output streaming`), with Vibe's read-only `ask` agent, so it never waits for
approval.

A reasoning effort works only over ACP, which sets Vibe's `thinking` option (Off, Low, High, Max).
`none` turns thinking off. Which levels a model takes depends on the model: on one machine,
`mistral-medium-latest` took `none` and `high`, and `zai-glm-5-3` took `low`, `high` and `max`.
A level the model does not take is rejected with the ones it does. The Vibe CLI has no effort flag,
so when sessions are off or `transports` sets `"mistral": "cli"`, effort suffixes and
`reasoning.effort` are rejected for `mistral`. While ACP cannot start and Mistral falls back to its
CLI, a request with an effort fails with `backend_unavailable` and can be retried:

```text
mistral/default        # Vibe's active model
mistral/devstral       # a Vibe model alias
mistral/devstral/high  # high thinking over ACP; rejected on the CLI
```

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
`gemini-3.7-flash-low` instead. Mistral Vibe accepts one only over ACP.

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

Clients then send `Authorization: Bearer local-secret`. `/health` and the [API docs](#api-docs-and-ai-agent-connection-prompt) remain unauthenticated. Do not bind to a non-loopback interface without appropriate host/network controls and an HTTP bearer token.

## Sandbox

By default, Agent2API runs every Agent CLI inside an OS-level sandbox built on
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (`srt`).
It uses Seatbelt (`sandbox-exec`) on macOS and bubblewrap on Linux, so no container or VM is involved.
Native Windows is not supported; use WSL2 (see [Windows (WSL2)](#windows-wsl2)).

To run the Agent CLIs without a sandbox, set `sandbox` to `false`. The Agents can then read and write
anything the current user can, and reach any host:

```json
{
  "backends": {
    "headless-core": {
      "cwd": ".",
      "sandbox": false
    }
  }
}
```

At startup Agent2API checks that the sandbox can run. On Linux (including WSL2) it needs `bwrap`,
`socat`, and `rg`, for example `sudo apt install bubblewrap socat ripgrep`. If the check fails,
Agent2API refuses to start rather than silently running without the sandbox; the error says how to
fix it or how to turn the sandbox off.
It then writes one srt settings file and one wrapper script per Agent to a temporary directory, and
points headless_core's `CODEX_BIN`, `CLAUDE_BIN`, `GROK_BIN`, `AGY_BIN`, `DEVIN_BIN`, and `VIBE_BIN` at those wrappers. The
directory is removed when the server shuts down. If you already set one of those variables, its value
is used as the real binary inside the sandbox.

The Agent still runs as the current user, so its existing login keeps working. That includes the
macOS Keychain (Claude Code) and credential files (`~/.codex/auth.json`). Token refresh also works,
because each Agent can write its own state directory.

Default policy for each Agent:

| | Network allowlist | Readable in your home | Writable | Notes |
|---|---|---|---|---|
| `claude` | `anthropic.com`, `claude.ai`, `claude.com` (+ subdomains) | `cwd`, its state, its binary, `~/Library/Keychains` (macOS) | `~/.claude`, `~/.claude.json` (or `$CLAUDE_CONFIG_DIR`) | |
| `codex` | `openai.com`, `chatgpt.com` (+ subdomains) | `cwd`, its state, its binary | `~/.codex` (or `$CODEX_HOME`) | `enableWeakerNetworkIsolation` for macOS TLS verification |
| `grok` | `x.ai`, `grok.com` (+ subdomains) | `cwd`, its state, its binary | `~/.grok` | |
| `agy` | `googleapis.com` (+ subdomains), `accounts.google.com` | `cwd`, its state, its binary, `~/Library/Keychains` (macOS) | `~/.gemini`, `~/.antigravity`, `cwd` | `enableWeakerNetworkIsolation`; on macOS it also needs the `allowLocalBinding` opt-in described below |
| `devin` | `devin.ai`, `codeium.com`, `windsurf.com` (+ subdomains) | `cwd`, its state, its binary | `~/.local/share/devin`, `~/.config/devin` (or under `$XDG_DATA_HOME` / `$XDG_CONFIG_HOME`) | `enableWeakerNetworkIsolation` for macOS TLS verification |
| `mistral` | `mistral.ai`, `mistral.services` (+ subdomains) | `cwd`, its state, its binary, `~/.agents` (shared skills, read-only), `~/Library/Keychains` (macOS) | `~/.vibe` (or `$VIBE_HOME`) | |

Reads and writes are both allowlists, so the Agents are isolated from your own files:

- **Reads**: everything under your home directory and under `/Volumes`, `/mnt` (the Windows drives in
  WSL2), and `/media` is denied, except the paths in the table. "Its state" is the Agent's writable
  directories. "Its binary" is the Agent CLI found on `PATH` (or `*_BIN`), every symlink on the way to
  it, and for a script its package directory and interpreter (for a Python virtual environment such as
  a `uv tool` install, the environment and its base Python). System locations such as `/usr`,
  `/System`, `/etc`, and `/opt/homebrew` stay readable, so the CLIs can start. The macOS Keychain
  database is readable only for the Agents that keep their login there; its items stay encrypted and
  guarded by the Keychain's own access control.
- **Writes**: denied everywhere except the table's writable paths and srt's own `/tmp/claude`, which
  srt sets as the Agent's `TMPDIR`. Even inside a writable `cwd`, srt blocks writes to shell and git
  files such as `.bashrc`, `.zshrc`, `.gitconfig`, `.git/hooks`, `.git/config`, `.mcp.json`,
  `.vscode/`, and `.idea/`.
- Common secrets (`~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`,
  `~/.git-credentials`, `~/.npmrc`, `~/.config/gh`, `~/.config/gcloud`) and the other Agents' state
  directories are also denied by name.

Because everything below `cwd` is readable, Agent2API refuses to start when `cwd` is your home
directory or a directory above it. Use a dedicated directory, such as `~/agent2api-work`.

If an Agent CLI is installed through a version manager shim (for example nodenv or asdf) or needs
another file in your home, it fails with a permission error. Add the path to `allowRead` for that
Agent.

To customize the policy, set `sandbox` to an object (`"type": "srt"` is optional). Lists you configure
are appended to these defaults: top-level lists apply to every Agent, and `agents.<id>` lists apply to
one. Booleans you set replace the defaults. Relative paths are resolved from the config file's
directory.

```json
{
  "backends": {
    "headless-core": {
      "sandbox": {
        "filesystem": { "allowRead": ["~/datasets"] },
        "agents": {
          "codex": { "filesystem": { "allowRead": ["~/.anyenv"] } },
          "agy": {
            "network": { "allowedDomains": ["lh3.googleusercontent.com"] },
            "filesystem": { "allowWrite": ["./generated"] }
          }
        }
      }
    }
  }
}
```

`enableWeakerNetworkIsolation` lets the sandboxed process reach macOS `com.apple.trustd.agent`. It is
enabled by default only for the Agents that need it.

`allowLocalBinding` is off for every Agent. Agy listens on random `127.0.0.1` ports for its built-in
language server:

- **Linux**: srt ignores the flag. The sandbox has its own loopback interface, so Agy works and cannot
  reach the host's local services.
- **macOS**: Seatbelt can allow those ports only together with connecting to every localhost port,
  including Agent2API itself and any local databases or development servers. Without the opt-in, Agy
  requests fail with a `backend_unavailable` error that names this setting. To accept that trade-off:

```json
{
  "backends": {
    "headless-core": {
      "sandbox": {
        "agents": { "agy": { "network": { "allowLocalBinding": true } } }
      }
    }
  }
}
```

If you opt in, also set `server.auth.bearerToken` so that a sandboxed Agent cannot call Agent2API
without the token.

### Windows (WSL2)

On Windows, run Agent2API and the Agent CLIs inside a WSL2 Linux distribution, whether or not you use
the sandbox. WSL1 does not work, because bubblewrap needs a real Linux kernel. Inside WSL2 the sandbox is the Linux one, so it works
without code changes, and Agy runs without `allowLocalBinding`. WSL2 ships with Windows, so this needs
no Docker Desktop or separate VM.

1. Install WSL2 and a distribution such as Ubuntu: `wsl --install`.
2. Inside the distribution, install the sandbox dependencies: `sudo apt install bubblewrap socat ripgrep`.
3. Inside the distribution, install Node.js 20+ and the Agent CLIs you want to use, and sign in to each
   one there. Windows-side logins are not shared with WSL.
4. Run `agent2api serve` inside the distribution. The sandbox is on by default.

With WSL2's default localhost forwarding, Windows applications reach the server at
`http://localhost:8080`. If they cannot, enable mirrored networking (`networkingMode=mirrored` in
`%UserProfile%\.wslconfig`). Keep the project and the Agent's `cwd` on the Linux file system
(for example `~/work`), not under `/mnt/c`, for speed and so the sandbox controls file access.

Native Windows is not supported. srt's Windows backend (alpha) runs commands as a separate
`srt-sandbox` user. That user has its own profile, cannot read the calling user's credential stores,
and cannot use the Windows TLS stack (Schannel). This conflicts with Agent2API's model of reusing
the Agent CLIs' existing logins. It also needs an administrator install step. On native Windows,
Agent2API refuses to start and points to WSL2. Setting `sandbox` to `false` skips that check, but
running the Agent CLIs on native Windows without a sandbox has not been tested either.

The WSL2 setup has not been tested yet. Please report any problems you hit.

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
- remote MCP

An Agent CLI may use its own internal tools. That does not expose OpenAI tool calling to an API client.

Unknown compatibility parameters that do not select one of these explicit features—such as
`temperature`, `top_p`, or a client-specific extension—are accepted by the external protocol
surface where compatible and are not forwarded as execution controls to headless_core. Explicit
tools, unsupported media, and files remain rejected.

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
- converts message history into a prompt, and keeps conversations open between requests
- converts responses and streaming events
- normalizes API-level errors

Agent2API does not implement authentication/OAuth for Agent CLIs, credential storage or rotation, direct AI Provider API calls, billing, a database, a web UI, Agent logic, or CLI process spawning. The sandbox wraps the binaries headless_core spawns; it does not spawn Agents itself.

## Development

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The normal test suite uses `FakeAgentBackend`; Codex, Claude Code, Grok, Agy, Devin, and Mistral Vibe are not required in CI. Real-Agent E2E tests, if added, should be opt-in with `AGENT2API_E2E=1`.

## License

MIT
