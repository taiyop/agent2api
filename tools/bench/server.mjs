#!/usr/bin/env node
// Agent2API Bench: a local GUI for checking an Agent2API server's OpenAI-compatible API.
//
// It serves one page and forwards the page's requests to Agent2API, so the API needs no CORS
// headers and a configured bearer token never reaches the browser. Only the Agent2API routes are
// forwarded, only to the configured target, and only for requests from the page's own origin.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PAGE_PATH = fileURLToPath(new URL("./index.html", import.meta.url));
const FORWARDED = new Map([
  ["/health", { method: "GET", underBase: false }],
  ["/v1/models", { method: "GET", underBase: true }],
  ["/v1/chat/completions", { method: "POST", underBase: true }],
  ["/v1/responses", { method: "POST", underBase: true }]
]);
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Works out where Agent2API listens from its config file, then applies explicit overrides.
 * @param {{ configPath?: string, target?: string, token?: string }} options
 */
export function resolveTarget(options = {}) {
  let target = "http://127.0.0.1:8080";
  let basePath = "";
  let token;
  if (options.configPath) {
    const config = JSON.parse(readFileSync(options.configPath, "utf8"));
    const server = config.server ?? {};
    const host = !server.host || server.host === "0.0.0.0" || server.host === "::" ? "127.0.0.1" : server.host;
    target = `http://${host.includes(":") ? `[${host}]` : host}:${server.port ?? 8080}`;
    basePath = (config.interfaces ?? []).find((entry) => entry.type === "openai")?.mountPath ?? "";
    token = server.auth?.bearerToken;
  }
  if (options.target) target = options.target;
  if (options.token) token = options.token;
  return { target: target.replace(/\/+$/, ""), basePath, token };
}

/**
 * @param {{ target: string, basePath?: string, token?: string, pagePath?: string }} options
 */
export function createBenchServer(options) {
  const basePath = options.basePath ?? "";
  const pagePath = options.pagePath ?? PAGE_PATH;

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const ownHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      // A Host check keeps DNS-rebinding pages from using the bench as a same-origin proxy.
      if (!ownHosts.includes(req.headers.host ?? "")) return sendError(res, 403, "Unexpected Host header");
      const url = new URL(req.url ?? "/", "http://bench.invalid");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY"
        });
        return res.end(await readFile(pagePath));
      }
      if (req.method === "GET" && url.pathname === "/bench/config") {
        return sendJson(res, 200, { target: options.target, basePath, tokenConfigured: Boolean(options.token) });
      }
      if (!url.pathname.startsWith("/proxy/")) return sendError(res, 404, "Not found");

      const route = url.pathname.slice("/proxy".length);
      const rule = FORWARDED.get(route);
      if (!rule) return sendError(res, 404, `The bench does not forward ${route}`);
      if (req.method !== rule.method) return sendError(res, 405, `${route} expects ${rule.method}`);
      if (req.method === "POST") {
        // Browsers always send Origin on POST; a page from another origin must not trigger Agent runs.
        const origin = req.headers.origin;
        if (!origin || !ownHosts.some((host) => origin === `http://${host}`)) {
          return sendError(res, 403, "Requests must come from the bench page");
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return sendError(res, 415, "Content-Type must be application/json");
        }
      }

      const body = req.method === "POST" ? await readBody(req) : undefined;
      const upstreamUrl = `${options.target}${rule.underBase ? basePath : ""}${route}`;
      const token = headerValue(req.headers["x-agent2api-token"]) || options.token;
      const controller = new AbortController();
      // Closing the page or pressing Cancel ends the browser request; pass that on so Agent2API
      // aborts the Agent run.
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          method: req.method,
          headers: {
            accept: headerValue(req.headers.accept) || "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          ...(body !== undefined ? { body } : {}),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
        return sendError(res, 502, `Cannot reach Agent2API at ${options.target}: ${cause}`);
      }

      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no"
      });
      res.flushHeaders();
      if (!upstream.body) return res.end();
      try {
        for await (const chunk of upstream.body) res.write(chunk);
      } catch {
        // The browser went away or Agent2API closed the stream; nothing left to forward.
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    }
  });
  return server;
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: "bench_proxy_error" } });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

/**
 * Listens on 127.0.0.1 and resolves with the bound port. `0` lets the OS pick any free port.
 * @param {import("node:http").Server} server
 * @param {number} port
 * @returns {Promise<number>}
 */
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error.code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use. Choose another with --port <n> or BENCH_PORT, or leave it unset for any free port.`)
        : error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function parseArgs(argv) {
  const options = {};
  const names = { "--config": "configPath", "-c": "configPath", "--target": "target", "--port": "port", "-p": "port" };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--help" || name === "-h") {
      options.help = true;
      continue;
    }
    const key = names[name];
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("-")) throw new Error(`Unknown or incomplete argument: ${name}`);
    options[key] = value;
    index++;
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: npm run bench -- [--config ./agent2api.config.json] [--target http://127.0.0.1:8080] [--port <n>]\n" +
        "Without --port (or BENCH_PORT) the bench listens on any free port and prints its URL.\n" +
        "Set AGENT2API_TOKEN to send a bearer token without a config file.\n"
    );
    return;
  }
  const resolved = resolveTarget({
    ...(args.configPath ? { configPath: path.resolve(args.configPath) } : {}),
    target: args.target ?? process.env.AGENT2API_URL,
    token: process.env.AGENT2API_TOKEN
  });
  const requested = args.port ?? process.env.BENCH_PORT;
  const server = createBenchServer(resolved);
  const port = await listen(server, requested === undefined ? 0 : parsePort(requested));
  process.stdout.write(
    `Agent2API Bench: http://127.0.0.1:${port}\n` +
      `  forwarding to ${resolved.target}${resolved.basePath}${resolved.token ? " (bearer token configured)" : ""}\n`
  );
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Agent2API Bench failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
