import type { SandboxAgentId } from "./sandboxConfig.js";

/** How headless_core talks to an Agent: `cli` starts the CLI for each request; the others keep it running. */
export type HeadlessCoreTransport = "cli" | "app-server" | "acp" | "sdk";

/** The transport that keeps each Agent running: codex app-server, the Claude Agent SDK, or ACP. */
export const PERSISTENT_TRANSPORTS: Readonly<Record<SandboxAgentId, Exclude<HeadlessCoreTransport, "cli">>> = {
  codex: "app-server",
  claude: "sdk",
  grok: "acp",
  agy: "acp",
  devin: "acp",
  mistral: "acp"
};

/**
 * The transport each Agent uses unless `transports` picks one. Agy stays on its CLI: its ACP server
 * answered with its own MCP start-up errors as the reply, and inside the sandbox it never opened a
 * session.
 */
export const DEFAULT_TRANSPORTS: Readonly<Record<SandboxAgentId, HeadlessCoreTransport>> = {
  ...PERSISTENT_TRANSPORTS,
  agy: "cli"
};

/** The transport an Agent runs on: the configured one, or its default. */
export function agentTransport(
  agent: string,
  transports?: Readonly<Partial<Record<string, HeadlessCoreTransport>>>
): HeadlessCoreTransport {
  return transports?.[agent] ?? DEFAULT_TRANSPORTS[agent as SandboxAgentId] ?? "cli";
}

/**
 * Agents that take a reasoning effort only over their persistent transport. Mistral Vibe's CLI has
 * no effort flag, while `vibe-acp` sets it through its `thinking` session option.
 */
export const EFFORT_NEEDS_PERSISTENT_TRANSPORT: ReadonlySet<string> = new Set(["mistral"]);

/**
 * The Agents that accept no `reasoning.effort` field, given how they run. Agy never does: its
 * effort is part of its model slugs. Mistral does only while it runs on ACP.
 */
export function agentsWithoutEffort(options: {
  readonly sessions: boolean;
  readonly transports?: Readonly<Partial<Record<string, HeadlessCoreTransport>>>;
} = { sessions: false }): ReadonlySet<string> {
  const agents = new Set(["agy"]);
  for (const agent of EFFORT_NEEDS_PERSISTENT_TRANSPORT) {
    if (!options.sessions || agentTransport(agent, options.transports) === "cli") agents.add(agent);
  }
  return agents;
}
