import type { Server } from "node:http";

export interface BenchTarget {
  target: string;
  basePath: string;
  token: string | undefined;
}

export function resolveTarget(options?: { configPath?: string; target?: string; token?: string }): BenchTarget;

export function listen(server: Server, port: number): Promise<number>;

export function createBenchServer(options: {
  target: string;
  basePath?: string;
  token?: string | undefined;
  pagePath?: string;
}): Server;
