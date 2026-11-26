import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Agent2APIConfig } from "../../config/schema.js";
import type { ModelRegistry } from "../../core/modelRegistry.js";

export const DOCS_PATH = "/docs";
export const OPENAPI_PATH = "/openapi.json";
const ASSETS_PATH = `${DOCS_PATH}/assets`;
const ASSETS: Readonly<Record<string, string>> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8"
};

const require = createRequire(import.meta.url);

/** Paths that stay reachable without the HTTP bearer token. They never contain the token itself. */
export function isDocsPath(requestPath: string): boolean {
  return requestPath === DOCS_PATH || requestPath === `${DOCS_PATH}/` || requestPath === OPENAPI_PATH ||
    requestPath.startsWith(`${ASSETS_PATH}/`);
}

export interface DocsOptions {
  readonly config: Agent2APIConfig;
  readonly models: ModelRegistry;
}

export function registerDocs(server: FastifyInstance, options: DocsOptions): void {
  const assetDirectory = path.dirname(require.resolve("swagger-ui-dist/package.json"));
  const version = packageVersion();

  server.get(OPENAPI_PATH, async (request) => buildOpenAPIDocument({ ...options, version, origin: originOf(request) }));
  server.get(DOCS_PATH, async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderDocsPage(options, version)));
  server.get(`${DOCS_PATH}/`, async (_request, reply) => reply.redirect(DOCS_PATH));
  server.get<{ Params: { file: string } }>(`${ASSETS_PATH}/:file`, async (request, reply) => {
    const contentType = ASSETS[request.params.file];
    if (!contentType) return reply.status(404).send({ error: { message: "Not found", type: "not_found", param: null, code: null } });
    const body = await readFile(path.join(assetDirectory, request.params.file));
    return reply.type(contentType).header("cache-control", "public, max-age=86400").send(body);
  });
}

function packageVersion(): string {
  try {
    // src/transport/http and dist/transport/http are both three levels below the package root.
    return (require("../../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function originOf(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

interface DocsSummary {
  readonly mountPaths: string[];
  readonly authRequired: boolean;
  readonly timeoutSeconds: number;
  readonly models: string[];
  readonly aliases: Record<string, string>;
}

function summarize({ config, models }: DocsOptions): DocsSummary {
  return {
    mountPaths: config.interfaces.map((entry) => entry.mountPath),
    authRequired: config.server.auth !== undefined,
    timeoutSeconds: Math.ceil(config.backends["headless-core"].timeoutMs / 1000),
    models: models.list().map((model) => model.id),
    aliases: { ...config.models.aliases }
  };
}

interface OpenAPIOptions extends DocsOptions {
  readonly version: string;
  readonly origin: string;
}

export function buildOpenAPIDocument(options: OpenAPIOptions): Record<string, unknown> {
  const summary = summarize(options);
  const modelIds = [...Object.keys(summary.aliases), ...summary.models];
  const defaultModel = summary.aliases.default !== undefined ? "default" : summary.models[0] ?? "codex/default";
  const security = summary.authRequired ? [{ bearerAuth: [] }] : [];
  const paths: Record<string, unknown> = {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        security: [],
        responses: { "200": jsonResponse("Server is running", { type: "object", properties: { status: { type: "string", const: "ok" } } }) }
      }
    }
  };
  const multiple = summary.mountPaths.length > 1;
  for (const mountPath of summary.mountPaths) {
    const tag = multiple ? `OpenAI (${mountPath || "/"})` : "OpenAI";
    paths[`${mountPath}/v1/models`] = {
      get: {
        tags: [tag],
        summary: "List configured models",
        description: "Returns the configured catalog. Unlisted canonical IDs such as `codex/<model>` may still be accepted by the Agent CLI.",
        security,
        responses: { "200": jsonResponse("Model list", { $ref: "#/components/schemas/ModelList" }), ...errorResponses(summary) }
      }
    };
    paths[`${mountPath}/v1/chat/completions`] = {
      post: {
        tags: [tag],
        summary: "Create a chat completion",
        description: "Runs the selected local Agent with the conversation. When `messages` continues a conversation the server keeps open, " +
          "only the new messages are sent to the Agent; send the header `X-Agent2API-Conversation: new` to always start over. " +
          "With `stream: true` the response is SSE: heartbeats while the Agent runs, then the whole answer as one delta, then `[DONE]`.",
        security,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
              example: { model: defaultModel, messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hello" }] }
            }
          }
        },
        responses: {
          "200": {
            description: "Chat completion (JSON), or an SSE stream when `stream: true`",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ChatCompletion" } },
              "text/event-stream": { schema: { type: "string" } }
            }
          },
          ...errorResponses(summary)
        }
      }
    };
    paths[`${mountPath}/v1/responses`] = {
      post: {
        tags: [tag],
        summary: "Create a response",
        description: "OpenAI Responses API subset. `previous_response_id` continues from an earlier response (`store: false` keeps none). Tools are not supported.",
        security,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResponseRequest" },
              example: { model: defaultModel, input: "Explain this repository in one sentence." }
            }
          }
        },
        responses: {
          "200": {
            description: "Response object (JSON), or an SSE stream when `stream: true`",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Response" } },
              "text/event-stream": { schema: { type: "string" } }
            }
          },
          ...errorResponses(summary)
        }
      }
    };
  }

  const modelSchema = {
    type: "string",
    description: "An alias, a configured model ID, or any canonical `<agent>/<model>[/<effort>]` ID.",
    examples: modelIds
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent2API",
      version: options.version,
      description: "OpenAI-compatible HTTP API backed by locally authenticated Agent CLIs (Claude Code, Codex, Grok, Agy).\n\n" +
        `Each request runs a whole Agent and may take up to ${summary.timeoutSeconds} seconds.`
    },
    servers: [{ url: options.origin }],
    paths,
    components: {
      ...(summary.authRequired ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } } : {}),
      schemas: {
        Model: modelSchema,
        Message: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "developer", "user", "assistant"] },
            content: {
              description: "Text, or an array of `{ type: \"text\", text }` parts. Image, audio, and file parts are rejected.",
              oneOf: [{ type: "string" }, { type: "array", items: { $ref: "#/components/schemas/TextPart" } }]
            }
          }
        },
        TextPart: {
          type: "object",
          required: ["type", "text"],
          properties: { type: { type: "string", enum: ["text", "input_text"] }, text: { type: "string" } }
        },
        ChatCompletionRequest: {
          type: "object",
          required: ["model", "messages"],
          properties: {
            model: { $ref: "#/components/schemas/Model" },
            messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
            stream: { type: "boolean", default: false },
            reasoning_effort: { $ref: "#/components/schemas/ReasoningEffort" }
          }
        },
        ResponseRequest: {
          type: "object",
          required: ["model", "input"],
          properties: {
            model: { $ref: "#/components/schemas/Model" },
            input: { oneOf: [{ type: "string" }, { type: "array", items: { $ref: "#/components/schemas/Message" } }] },
            instructions: { type: "string" },
            stream: { type: "boolean", default: false },
            reasoning: { type: "object", properties: { effort: { $ref: "#/components/schemas/ReasoningEffort" } } }
          }
        },
        ReasoningEffort: {
          type: "string",
          description: "Forwarded to the Agent CLI. Not supported by Agy; use an Agy model slug instead.",
          enum: ["default", "low", "medium", "high", "xhigh", "max"]
        },
        ModelList: {
          type: "object",
          properties: {
            object: { type: "string", const: "list" },
            data: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, object: { type: "string", const: "model" }, owned_by: { type: "string" } }
              }
            }
          }
        },
        ChatCompletion: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { type: "string", const: "chat.completion" },
            model: { type: "string" },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  message: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
                  finish_reason: { type: "string" }
                }
              }
            }
          }
        },
        Response: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { type: "string", const: "response" },
            model: { type: "string" },
            output_text: { type: "string" },
            output: { type: "array", items: { type: "object" } }
          }
        },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                type: { type: "string" },
                param: { type: ["string", "null"] },
                code: { type: ["string", "null"], examples: ["unsupported_feature", "model_not_found", "invalid_api_key"] }
              }
            }
          }
        }
      }
    },
    ...(summary.authRequired ? { security } : {})
  };
}

function jsonResponse(description: string, schema: unknown): Record<string, unknown> {
  return { description, content: { "application/json": { schema } } };
}

function errorResponses(summary: DocsSummary): Record<string, unknown> {
  const error = (description: string) => jsonResponse(description, { $ref: "#/components/schemas/Error" });
  return {
    "400": error("Invalid request, or an unsupported feature such as tools or image input"),
    ...(summary.authRequired ? { "401": error("Missing or invalid bearer token") } : {}),
    "404": error("Unknown model"),
    "500": error("Agent execution failed")
  };
}

function renderDocsPage(options: DocsOptions, version: string): string {
  const data = JSON.stringify({ ...summarize(options), version, openapiPath: OPENAPI_PATH }).replace(/</g, "\\u003c");
  return DOCS_HTML.replace("__AGENT2API_DOCS_DATA__", () => data);
}

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent2API Docs</title>
<link rel="stylesheet" href="${ASSETS_PATH}/swagger-ui.css">
<style>
  :root { --bg: #fafafa; --card: #fff; --text: #1f2328; --muted: #59636e; --border: #d1d9e0; --accent: #0969da; --accent-text: #fff; --code: #f6f8fa; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif; }
  .wrap { max-width: 1460px; margin: 0 auto; padding: 24px 20px 0; }
  header h1 { margin: 0; font-size: 24px; }
  header p { margin: 4px 0 0; color: var(--muted); }
  .card { margin-top: 20px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
  .card h2 { margin: 0 0 4px; font-size: 16px; }
  .card > p { margin: 0 0 12px; color: var(--muted); }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 12px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button { border: 0; background: transparent; padding: 6px 12px; cursor: pointer; font: inherit; color: var(--text); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); }
  label.token { display: inline-flex; gap: 8px; align-items: center; color: var(--muted); }
  label.token input { font: inherit; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; width: 240px; }
  .copy { margin-left: auto; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text); padding: 7px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  .copy:focus-visible, .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  pre.prompt { margin: 0; max-height: 320px; overflow: auto; background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 12px; white-space: pre-wrap; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .status { min-height: 1.5em; margin: 6px 0 0; color: var(--muted); font-size: 12px; }
  .swagger-ui .information-container { display: none; }
  @media (max-width: 640px) { .copy { margin-left: 0; width: 100%; } label.token input { width: 100%; } label.token { width: 100%; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Agent2API <small id="version" style="font-size:13px;color:var(--muted)"></small></h1>
    <p>OpenAI-compatible API for locally authenticated Agent CLIs. <a id="spec-link" href="${OPENAPI_PATH}">openapi.json</a></p>
  </header>
  <section class="card" aria-labelledby="prompt-title">
    <h2 id="prompt-title">AI Agent connection prompt</h2>
    <p>Copy this text and give it to an AI agent so it knows how to call this server.</p>
    <div class="controls">
      <div class="seg" role="group" aria-label="Prompt language">
        <button type="button" data-lang="en" aria-pressed="true">English</button>
        <button type="button" data-lang="ja" aria-pressed="false">日本語</button>
      </div>
      <label class="token" id="token-field" hidden>Bearer token
        <input id="token" type="password" autocomplete="off" placeholder="leave empty for a placeholder">
      </label>
      <button type="button" class="copy" id="copy">Copy prompt</button>
    </div>
    <pre class="prompt" id="prompt" tabindex="0"></pre>
    <p class="status" id="status" role="status" aria-live="polite"></p>
  </section>
</div>
<div id="swagger-ui"></div>
<script type="application/json" id="agent2api-docs-data">__AGENT2API_DOCS_DATA__</script>
<script src="${ASSETS_PATH}/swagger-ui-bundle.js"></script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("agent2api-docs-data").textContent);
  var origin = window.location.origin;
  var lang = "en";
  var tokenInput = document.getElementById("token");
  document.getElementById("version").textContent = "v" + data.version;
  if (data.authRequired) document.getElementById("token-field").hidden = false;

  function baseUrls() { return data.mountPaths.map(function (mount) { return origin + mount + "/v1"; }); }
  function modelLines() {
    var lines = Object.keys(data.aliases).map(function (alias) { return "  - " + alias + " → " + data.aliases[alias]; });
    return lines.concat(data.models.map(function (id) { return "  - " + id; })).join("\\n");
  }

  function buildPrompt() {
    var base = baseUrls()[0];
    var token = tokenInput.value.trim() || "<AGENT2API_TOKEN>";
    var model = data.aliases["default"] !== undefined ? "default" : (data.models[0] || "codex/default");
    var authHeader = data.authRequired ? " \\\\\\n  -H \\"Authorization: Bearer " + token + "\\"" : "";
    var curl = "curl " + base + "/chat/completions \\\\\\n  -H \\"Content-Type: application/json\\"" + authHeader +
      " \\\\\\n  -d '{\\"model\\": \\"" + model + "\\", \\"messages\\": [{\\"role\\": \\"user\\", \\"content\\": \\"Hello\\"}]}'";
    var extraBases = baseUrls().slice(1);
    if (lang === "ja") {
      return [
        "Agent2API という OpenAI 互換 HTTP API を利用できます。リクエストはローカルで認証済みの Agent CLI（Claude Code / Codex / Grok / Agy）が処理します。",
        "",
        "## 接続情報",
        "- Base URL: " + base + (extraBases.length ? "（他のマウント: " + extraBases.join(", ") + "）" : ""),
        "- 認証: " + (data.authRequired ? "Authorization: Bearer " + token : "不要（OpenAI SDK では apiKey に任意の文字列を指定）"),
        "- OpenAPI 仕様: " + origin + data.openapiPath,
        "",
        "## エンドポイント",
        "- GET  " + base + "/models — 設定済みモデル一覧",
        "- POST " + base + "/chat/completions — Chat Completions API",
        "- POST " + base + "/responses — Responses API",
        "",
        "## モデル（model フィールドに指定）",
        modelLines(),
        "- 上記以外も <agent>/<model>[/<effort>] 形式で指定可能（例: claude/opus, codex/default/high）。effort は default|low|medium|high|xhigh|max。",
        "",
        "## 注意事項",
        "- 1 リクエストごとに Agent が丸ごと実行されるため、応答に最大 " + data.timeoutSeconds + " 秒かかります。クライアントのタイムアウトはそれ以上にしてください。",
        "- stream: true で SSE が使えますが、完了までハートビートのみで、最後に回答全体が 1 つの delta で届きます。HTTP 200 は接続確立を意味し、実行エラーは SSE の error イベントで届きます。",
        "- 非対応: tools / tool_calls、画像・音声・ファイル入力、embeddings。指定すると unsupported_feature エラーになります。",
        "- Chat Completions では毎回 messages に履歴全体を含めてください。続きの会話はサーバーが自動で見分け、新しいメッセージだけを Agent に渡します。必ず新しい会話にするときはヘッダー X-Agent2API-Conversation: new を付けます。",
        "- Responses API では previous_response_id で前の応答の続きにできます（input は新しいメッセージだけ）。",
        "- OpenAI SDK を使う場合は baseURL に Base URL を設定してください。",
        "",
        "## 例",
        curl
      ].join("\\n");
    }
    return [
      "You can use Agent2API, an OpenAI-compatible HTTP API. Requests are handled by locally authenticated Agent CLIs (Claude Code, Codex, Grok, Agy).",
      "",
      "## Connection",
      "- Base URL: " + base + (extraBases.length ? " (other mounts: " + extraBases.join(", ") + ")" : ""),
      "- Authentication: " + (data.authRequired ? "Authorization: Bearer " + token : "none (with the OpenAI SDK, set apiKey to any string)"),
      "- OpenAPI spec: " + origin + data.openapiPath,
      "",
      "## Endpoints",
      "- GET  " + base + "/models — list configured models",
      "- POST " + base + "/chat/completions — Chat Completions API",
      "- POST " + base + "/responses — Responses API",
      "",
      "## Models (use as the model field)",
      modelLines(),
      "- Other IDs in the form <agent>/<model>[/<effort>] are also accepted (e.g. claude/opus, codex/default/high). effort is one of default|low|medium|high|xhigh|max.",
      "",
      "## Notes",
      "- Every request runs a whole Agent, so a response can take up to " + data.timeoutSeconds + " seconds. Set your client timeout above that.",
      "- stream: true returns SSE, but only heartbeats are sent until the Agent finishes; then the whole answer arrives as one delta. HTTP 200 means the stream opened; execution errors arrive as an SSE error event.",
      "- Not supported: tools / tool_calls, image, audio, and file input, embeddings. Using them returns an unsupported_feature error.",
      "- With Chat Completions, send the full history in messages on every request. The server recognizes a conversation it keeps open and passes only the new messages to the Agent. To always start a new conversation, send the header X-Agent2API-Conversation: new.",
      "- With the Responses API, previous_response_id continues from an earlier response (input then holds only the new messages).",
      "- With the OpenAI SDK, set baseURL to the Base URL above.",
      "",
      "## Example",
      curl
    ].join("\\n");
  }

  var promptEl = document.getElementById("prompt");
  var statusEl = document.getElementById("status");
  function render() { promptEl.textContent = buildPrompt(); statusEl.textContent = ""; }

  document.querySelectorAll(".seg button").forEach(function (button) {
    button.addEventListener("click", function () {
      lang = button.getAttribute("data-lang");
      document.querySelectorAll(".seg button").forEach(function (other) { other.setAttribute("aria-pressed", String(other === button)); });
      render();
    });
  });
  tokenInput.addEventListener("input", render);

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
  document.getElementById("copy").addEventListener("click", function () {
    var text = buildPrompt();
    function done(ok) { statusEl.textContent = ok ? "Copied to clipboard." : "Copy failed. Select the text above and copy it manually."; }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  });

  render();
  window.ui = SwaggerUIBundle({
    url: data.openapiPath,
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: false,
    tryItOutEnabled: false
  });
})();
</script>
</body>
</html>
`;
