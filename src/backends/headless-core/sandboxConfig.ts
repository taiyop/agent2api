export const SANDBOX_AGENT_IDS = ["codex", "claude", "grok", "agy", "devin", "mistral"] as const;
export type SandboxAgentId = (typeof SANDBOX_AGENT_IDS)[number];

/** User additions to the built-in sandbox rules. Lists are appended to the defaults. */
export interface SandboxRules {
  readonly network?: {
    readonly allowedDomains?: readonly string[];
    readonly deniedDomains?: readonly string[];
    readonly allowLocalBinding?: boolean;
  };
  readonly filesystem?: {
    readonly denyRead?: readonly string[];
    readonly allowRead?: readonly string[];
    readonly allowWrite?: readonly string[];
    readonly denyWrite?: readonly string[];
  };
  readonly enableWeakerNetworkIsolation?: boolean;
}

export interface SrtSandboxConfig extends SandboxRules {
  readonly type: "srt";
  readonly agents?: Partial<Record<SandboxAgentId, SandboxRules>>;
}

export type HeadlessCoreSandboxConfig = SrtSandboxConfig;
