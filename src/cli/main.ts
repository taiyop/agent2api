#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { startServer } from "../transport/http/server.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "serve") {
    printUsage();
    process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
    return;
  }
  const configPath = readOption(args, "--config", "-c");
  const config = await loadConfig(configPath);
  const server = await startServer(config);
  process.stdout.write(`Agent2API listening on http://${config.server.host}:${config.server.port}\n\nInterfaces:\n`);
  for (const entry of config.interfaces) {
    process.stdout.write(`  OpenAI: ${entry.prefix}\n`);
  }
  const shutdown = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function readOption(args: string[], longName: string, shortName: string): string | undefined {
  const index = args.findIndex((value) => value === longName || value === shortName);
  if (index === -1) {
    if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${longName} requires a value`);
  const remaining = args.filter((_value, position) => position !== index && position !== index + 1);
  if (remaining.length > 0) throw new Error(`Unknown arguments: ${remaining.join(" ")}`);
  return value;
}

function printUsage(): void {
  process.stdout.write("Usage: agent2api serve [--config ./agent2api.config.json]\n");
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Agent2API failed to start: ${message}\n`);
  process.exitCode = 1;
});
