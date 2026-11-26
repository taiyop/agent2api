#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import type { Agent2APIConfig } from "../config/schema.js";
import { startServer } from "../transport/http/server.js";

interface ServeOptions {
  readonly configPath?: string;
  readonly port?: number;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "serve") {
    printUsage();
    process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
    return;
  }
  const options = parseServeOptions(args);
  const loaded = await loadConfig(options.configPath);
  const config: Agent2APIConfig = options.port === undefined
    ? loaded
    : { ...loaded, server: { ...loaded.server, port: options.port } };
  const server = await startServer(config).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${config.server.port} on ${config.server.host} is already in use. ` +
          "Choose another with --port <n> or server.port in the config file."
      );
    }
    throw error;
  });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.server.port;
  process.stdout.write(`Agent2API listening on http://${config.server.host}:${port}\n\nInterfaces:\n`);
  for (const entry of config.interfaces) {
    process.stdout.write(`  OpenAI: ${entry.mountPath}/v1\n`);
  }
  const shutdown = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function parseServeOptions(args: string[]): ServeOptions {
  let configPath: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    const value = args[index + 1];
    if (name === "--config" || name === "-c") {
      if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
      configPath = value;
    } else if (name === "--port" || name === "-p") {
      if (!value) throw new Error(`${name} requires a value`);
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
    } else {
      throw new Error(`Unknown arguments: ${args.slice(index).join(" ")}`);
    }
    index++;
  }
  return { ...(configPath ? { configPath } : {}), ...(port !== undefined ? { port } : {}) };
}

function printUsage(): void {
  process.stdout.write("Usage: agent2api serve [--config ./agent2api.config.json] [--port 8080]\n");
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Agent2API failed to start: ${message}\n`);
  process.exitCode = 1;
});
