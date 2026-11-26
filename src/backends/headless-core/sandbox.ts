import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { SANDBOX_AGENT_IDS, type SandboxAgentId, type SandboxRules, type SrtSandboxConfig } from "./sandboxConfig.js";

export { SANDBOX_AGENT_IDS, type HeadlessCoreSandboxConfig, type SandboxAgentId, type SandboxRules, type SrtSandboxConfig } from "./sandboxConfig.js";

/** The settings file format read by `srt --settings`. */
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  enableWeakerNetworkIsolation: boolean;
}

export interface PrepareSrtSandboxOptions {
  readonly config: SrtSandboxConfig;
  /** Working directory the Agent CLIs run in. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the bundled `srt` CLI entrypoint (tests). */
  readonly srtCliPath?: string;
  /** Overrides the platform dependency check (tests). */
  readonly skipDependencyCheck?: boolean;
}

export interface PreparedSandbox {
  /** Environment for headless_core with each `*_BIN` pointing at a sandboxed wrapper. */
  readonly env: NodeJS.ProcessEnv;
  /** Directory holding the generated settings and wrapper scripts. */
  readonly directory: string;
  readonly settings: Readonly<Record<SandboxAgentId, SrtSettings>>;
  dispose(): void;
}

const BIN_ENV: Record<SandboxAgentId, string> = {
  codex: "CODEX_BIN",
  claude: "CLAUDE_BIN",
  grok: "GROK_BIN",
  agy: "AGY_BIN",
  devin: "DEVIN_BIN",
  mistral: "VIBE_BIN"
};

/** The command headless_core runs when the `*_BIN` variable is unset. */
const DEFAULT_COMMAND: Record<SandboxAgentId, string> = {
  codex: "codex",
  claude: "claude",
  grok: "grok",
  agy: "agy",
  devin: "devin",
  mistral: "vibe"
};

/**
 * The separate programs headless_core starts for an Agent's persistent transport, when it does not
 * reuse the CLI above (codex app-server, grok and devin ACP do). The Claude Agent SDK runs the
 * installed `claude` instead of the copy bundled with the SDK, so both transports use one login.
 */
const PERSISTENT_BIN: Partial<Record<SandboxAgentId, { readonly env: string; readonly commands: (env: NodeJS.ProcessEnv) => string[] }>> = {
  claude: { env: "CLAUDE_SDK_BIN", commands: (env) => [env.CLAUDE_BIN || "claude"] },
  agy: { env: "AGY_ACP_BIN", commands: () => ["agy_acp_server", "agy_acp_server.par"] },
  mistral: { env: "VIBE_ACP_BIN", commands: () => ["vibe-acp"] }
};

/**
 * Arguments put in front of the Agent's own. The user's codex hooks (`~/.codex/hooks.json`) are
 * meant for interactive use; under app-server they can keep a turn from ever completing, and under
 * `codex exec` they can add minutes to a run.
 */
const AGENT_ARGS: Partial<Record<SandboxAgentId, readonly string[]>> = {
  codex: ["--disable", "hooks"]
};

interface AgentLaunch {
  readonly env: string;
  readonly realBin: string;
  readonly args: readonly string[];
}

/** Every program headless_core may start for the Agent, with the `*_BIN` variable that names it. */
function agentLaunches(agent: SandboxAgentId, env: NodeJS.ProcessEnv): AgentLaunch[] {
  const launches: AgentLaunch[] = [
    { env: BIN_ENV[agent], realBin: env[BIN_ENV[agent]] || DEFAULT_COMMAND[agent], args: AGENT_ARGS[agent] ?? [] }
  ];
  const persistent = PERSISTENT_BIN[agent];
  if (persistent) {
    const candidates = persistent.commands(env);
    const realBin = env[persistent.env]
      || candidates.find((command) => resolveExecutableReadPaths(command, env).length > 0)
      || candidates[0]!;
    launches.push({ env: persistent.env, realBin, args: [] });
  }
  return launches;
}

/**
 * Locations holding the user's own files. Reads under them are denied, and only the paths an Agent
 * needs are allowed back, so the Agent sees the system (/usr, /System, /etc, ...) but not the user's
 * data. `/mnt` covers the Windows drives under WSL2.
 */
const ISOLATED_ROOTS = ["~", "/Volumes", "/mnt", "/media"];

/** Credentials and secrets no Agent needs, denied even if a broader allowRead re-opens them. */
const SENSITIVE_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.gnupg",
  "~/.kube",
  "~/.docker",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.config/gh",
  "~/.config/gcloud"
];

interface AgentDefaults {
  readonly stateDirs: (env: NodeJS.ProcessEnv) => string[];
  /** Further paths under the isolated roots the Agent must read, by platform. */
  readonly extraReadPaths?: (platform: NodeJS.Platform) => string[];
  readonly allowedDomains: readonly string[];
  readonly allowLocalBinding: boolean;
  /** Lets the Agent reach com.apple.trustd.agent, which native TLS stacks need to verify certificates on macOS. */
  readonly enableWeakerNetworkIsolation: boolean;
  readonly writeWorkspace: boolean;
}

const AGENT_DEFAULTS: Record<SandboxAgentId, AgentDefaults> = {
  claude: {
    stateDirs: (env) => env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : ["~/.claude", "~/.claude.json"],
    // Claude Code keeps its login in the macOS Keychain, whose database the Security framework reads.
    extraReadPaths: (platform) => platform === "darwin" ? ["~/Library/Keychains"] : [],
    allowedDomains: ["anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai", "claude.com", "*.claude.com"],
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: false,
    writeWorkspace: false
  },
  codex: {
    stateDirs: (env) => [env.CODEX_HOME ?? "~/.codex"],
    allowedDomains: ["openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"],
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: true,
    writeWorkspace: false
  },
  grok: {
    stateDirs: () => ["~/.grok"],
    allowedDomains: ["x.ai", "*.x.ai", "grok.com", "*.grok.com"],
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: false,
    writeWorkspace: false
  },
  agy: {
    stateDirs: () => ["~/.gemini", "~/.antigravity"],
    // Agy also keeps its Google login in the macOS Keychain. The ACP registry installs
    // agy_acp_server.par under ~/.local/share and puts a shim on PATH that runs it.
    extraReadPaths: (platform) => [
      "~/.local/share/antigravity-acp",
      ...(platform === "darwin" ? ["~/Library/Keychains"] : [])
    ],
    allowedDomains: ["googleapis.com", "*.googleapis.com", "accounts.google.com"],
    // Agy listens on random 127.0.0.1 ports for its built-in language server. On macOS srt can only
    // allow that together with connecting to every localhost port, so it is opt-in. On Linux srt
    // ignores the flag because the sandbox has its own loopback, and Agy runs without it.
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: true,
    // headless_core runs Agy with accept-edits so tools such as image generation can write files.
    writeWorkspace: true
  },
  devin: {
    // Its login (credentials.toml), sessions and installed versions live in the XDG data directory.
    stateDirs: (env) => [
      path.join(env.XDG_DATA_HOME ?? "~/.local/share", "devin"),
      path.join(env.XDG_CONFIG_HOME ?? "~/.config", "devin")
    ],
    // api.devin.ai and app.devin.ai for the account, server.codeium.com for inference and
    // unleash.codeium.com for feature flags, static.windsurf.com for assets.
    allowedDomains: ["devin.ai", "*.devin.ai", "codeium.com", "*.codeium.com", "windsurf.com", "*.windsurf.com"],
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: true,
    // headless_core runs Devin with `--permission-mode auto`, which auto-approves read-only tools only.
    writeWorkspace: false
  },
  mistral: {
    stateDirs: (env) => [env.VIBE_HOME ?? "~/.vibe"],
    // Vibe fails to start when it cannot list the shared skills in ~/.agents (read-only here), and
    // keeps its API key in the system keyring (the macOS Keychain) unless ~/.vibe/.env holds it.
    extraReadPaths: (platform) => ["~/.agents", ...(platform === "darwin" ? ["~/Library/Keychains"] : [])],
    // api.mistral.ai for inference, auth.mistral.ai for the login, experiments.mistral.services for
    // the feature flags Vibe fetches on start.
    allowedDomains: ["mistral.ai", "*.mistral.ai", "mistral.services", "*.mistral.services"],
    allowLocalBinding: false,
    enableWeakerNetworkIsolation: false,
    // headless_core runs Vibe with its read-only `ask` agent.
    writeWorkspace: false
  }
};

export interface BuildSrtSettingsOptions {
  /** Paths of the Agent binary and its runtime that must stay readable (see `resolveExecutableReadPaths`). */
  readonly executablePaths?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

/**
 * Builds the srt settings for one Agent from the built-in defaults and the user's additions.
 *
 * Reads are an allowlist: everything under the isolated roots (the home directory and mounted
 * volumes) is denied except the working directory, the Agent's own state, its binary, and paths the
 * user adds with `allowRead`. Writes are an allowlist too.
 */
export function buildSrtSettings(
  agent: SandboxAgentId,
  config: SrtSandboxConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: BuildSrtSettingsOptions = {}
): SrtSettings {
  const defaults = AGENT_DEFAULTS[agent];
  const platform = options.platform ?? process.platform;
  const own = defaults.stateDirs(env);
  const otherAgents = SANDBOX_AGENT_IDS
    .filter((id) => id !== agent)
    .flatMap((id) => AGENT_DEFAULTS[id].stateDirs(env))
    .filter((dir) => !own.includes(dir));
  const layers = [config, config.agents?.[agent] ?? {}];
  const collect = (pick: (rules: SandboxRules) => readonly string[] | undefined) =>
    layers.flatMap((rules) => pick(rules) ?? []);
  const lastDefined = <T>(pick: (rules: SandboxRules) => T | undefined, fallback: T): T =>
    layers.reduce<T>((value, rules) => pick(rules) ?? value, fallback);

  return {
    network: {
      allowedDomains: unique([...defaults.allowedDomains, ...collect((rules) => rules.network?.allowedDomains)]),
      deniedDomains: unique(collect((rules) => rules.network?.deniedDomains)),
      allowLocalBinding: lastDefined((rules) => rules.network?.allowLocalBinding, defaults.allowLocalBinding)
    },
    filesystem: {
      denyRead: unique([
        ...ISOLATED_ROOTS,
        ...SENSITIVE_PATHS,
        ...otherAgents,
        ...collect((rules) => rules.filesystem?.denyRead)
      ]),
      allowRead: unique([
        cwd,
        ...own,
        ...(options.executablePaths ?? []),
        ...(defaults.extraReadPaths?.(platform) ?? []),
        ...collect((rules) => rules.filesystem?.allowRead)
      ]),
      allowWrite: unique([
        ...own,
        ...(defaults.writeWorkspace ? [cwd] : []),
        ...collect((rules) => rules.filesystem?.allowWrite)
      ]),
      denyWrite: unique(collect((rules) => rules.filesystem?.denyWrite))
    },
    enableWeakerNetworkIsolation: lastDefined(
      (rules) => rules.enableWeakerNetworkIsolation,
      defaults.enableWeakerNetworkIsolation
    )
  };
}

/**
 * Writes one srt settings file and one wrapper script per Agent, and returns an
 * environment whose `*_BIN` variables make headless_core spawn every Agent CLI
 * through `srt`. The Agent still runs as the current user, so its existing
 * login (Keychain or credential files) keeps working within the policy.
 */
export function prepareSrtSandbox(options: PrepareSrtSandboxOptions): PreparedSandbox {
  const env = options.env ?? process.env;
  if (!options.skipDependencyCheck) assertSandboxAvailable();
  assertIsolatedCwd(options.cwd, env);
  const srtCliPath = options.srtCliPath ?? resolveSrtCliPath();
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent2api-srt-"));
  const sandboxEnv: NodeJS.ProcessEnv = { ...env };
  const settings = {} as Record<SandboxAgentId, SrtSettings>;
  try {
    for (const agent of SANDBOX_AGENT_IDS) {
      const launches = agentLaunches(agent, env);
      const agentSettings = buildSrtSettings(agent, options.config, options.cwd, env, {
        executablePaths: unique(launches.flatMap((launch) => resolveExecutableReadPaths(launch.realBin, env)))
      });
      settings[agent] = agentSettings;
      const settingsPath = path.join(directory, `${agent}.srt-settings.json`);
      writeFileSync(settingsPath, `${JSON.stringify(agentSettings, null, 2)}\n`, { mode: 0o600 });
      for (const launch of launches) {
        const wrapperPath = path.join(directory, launch.env === BIN_ENV[agent] ? agent : `${agent}-${launch.env.toLowerCase()}`);
        const command = [process.execPath, srtCliPath, "--settings", settingsPath, "--", launch.realBin, ...launch.args];
        writeWrapper(wrapperPath, command);
        sandboxEnv[launch.env] = wrapperPath;
      }
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.off("exit", dispose);
    rmSync(directory, { recursive: true, force: true });
  };
  process.once("exit", dispose);
  return { env: sandboxEnv, directory, settings, dispose };
}

/**
 * Finds the paths that must stay readable for `command` to start: the file found on PATH, every
 * link it resolves through, and the final file. For a script, also its package directory and its
 * interpreter (one level, e.g. `#!/usr/bin/env node`). Commands that are not found yield nothing.
 *
 * A bare command name covers every match on PATH, not only the first: wrappers that terminals and
 * version managers put in front (such as cmux's `codex`) run the next match on PATH, which must be
 * readable too.
 */
export function resolveExecutableReadPaths(command: string, env: NodeJS.ProcessEnv, depth = 0): string[] {
  if (command.includes("/")) return resolveFileReadPaths(path.resolve(command), env, depth);
  const matches = depth === 0 ? findAllOnPath(command, env.PATH) : findAllOnPath(command, env.PATH).slice(0, 1);
  return unique(matches.flatMap((found) => resolveFileReadPaths(found, env, depth)));
}

function resolveFileReadPaths(found: string, env: NodeJS.ProcessEnv, depth: number): string[] {
  try {
    accessSync(found, constants.F_OK);
  } catch {
    return [];
  }
  const paths = [found];
  let current = found;
  for (let hop = 0; hop < 16; hop++) {
    let target: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      target = path.resolve(path.dirname(current), readlinkSync(current));
    } catch {
      break;
    }
    paths.push(target);
    current = target;
  }
  try {
    const real = realpathSync(found);
    paths.push(real);
    const interpreter = readShebang(real);
    if (interpreter && depth === 0) {
      const packageRoot = findPackageRoot(real);
      if (packageRoot) paths.push(packageRoot);
      paths.push(...findPythonEnvironment(real));
      paths.push(...resolveExecutableReadPaths(interpreter, env, depth + 1));
    }
  } catch {
    // An unreadable or vanished file contributes only what was found so far.
  }
  return unique(paths);
}

function findAllOnPath(command: string, searchPath: string | undefined): string[] {
  const matches: string[] = [];
  for (const directory of (searchPath ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) matches.push(candidate);
    } catch {
      // Not here; keep looking.
    }
  }
  return unique(matches);
}

/** Returns the program a `#!` line runs, looking through `/usr/bin/env`. */
function readShebang(file: string): string | undefined {
  const buffer = Buffer.alloc(256);
  const fd = openSync(file, "r");
  let length: number;
  try {
    length = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.subarray(0, length).toString("utf8");
  if (!head.startsWith("#!")) return undefined;
  const [program, ...args] = head.slice(2).split("\n")[0]!.trim().split(/\s+/);
  if (!program) return undefined;
  if (path.basename(program) !== "env") return program;
  return args.find((arg) => !arg.startsWith("-") && !arg.includes("="));
}

/**
 * A script installed into a Python virtual environment (uv tool, pipx, venv) needs the whole
 * environment for its packages, and the base installation `pyvenv.cfg` names for the standard library.
 */
function findPythonEnvironment(file: string): string[] {
  const root = path.dirname(path.dirname(file));
  let config: string;
  try {
    config = readFileSync(path.join(root, "pyvenv.cfg"), "utf8");
  } catch {
    return [];
  }
  const paths = [root];
  const home = /^home\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
  if (home) {
    const base = path.dirname(path.resolve(root, home));
    paths.push(base);
    try {
      paths.push(realpathSync(base));
    } catch {
      // A missing base installation leaves the interpreter to fail on its own.
    }
  }
  return paths;
}

function findPackageRoot(file: string): string | undefined {
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
  }
  return undefined;
}

/**
 * Allowing the working directory re-opens everything below it, so a working directory that is the
 * home directory (or above it) would undo the read isolation.
 */
function assertIsolatedCwd(cwd: string, env: NodeJS.ProcessEnv): void {
  const home = path.resolve(env.HOME || os.homedir());
  const resolved = path.resolve(cwd);
  if (home === resolved || home.startsWith(`${resolved}${path.sep}`) || resolved === path.parse(resolved).root) {
    throw new Error(
      `The sandbox working directory ${resolved} contains the home directory, which would let the Agents read ` +
        "all of it. Set backends.headless-core.cwd to a dedicated directory, such as ~/agent2api-work. " +
        DISABLE_HINT
    );
  }
}

/**
 * Starts the Agents the same way without a sandbox: the persistent transports run the installed
 * CLIs, and codex starts without the user's hooks. Native Windows has no `sh` for the wrappers, so
 * the environment is left as it is there.
 */
export function prepareDirectLaunchers(env: NodeJS.ProcessEnv = process.env): PreparedLaunchers {
  if (process.platform === "win32") return { env: { ...env }, dispose: () => undefined };
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent2api-bin-"));
  const launchEnv: NodeJS.ProcessEnv = { ...env };
  try {
    for (const agent of SANDBOX_AGENT_IDS) {
      for (const launch of agentLaunches(agent, env)) {
        const unchanged = launch.args.length === 0 && launch.env === BIN_ENV[agent];
        if (unchanged) continue;
        if (launch.args.length === 0) {
          // A persistent transport's own program: point it at the installed CLI when there is one.
          const found = resolveExecutableReadPaths(launch.realBin, env)[0];
          if (found) launchEnv[launch.env] = found;
          continue;
        }
        const wrapperPath = path.join(directory, agent);
        writeWrapper(wrapperPath, [launch.realBin, ...launch.args]);
        launchEnv[launch.env] = wrapperPath;
      }
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.off("exit", dispose);
    rmSync(directory, { recursive: true, force: true });
  };
  process.once("exit", dispose);
  return { env: launchEnv, dispose };
}

export interface PreparedLaunchers {
  readonly env: NodeJS.ProcessEnv;
  dispose(): void;
}

function writeWrapper(wrapperPath: string, command: readonly string[]): void {
  // In the srt command, `--` keeps srt from reading the Agent's own flags or a prompt starting with
  // '-' as srt options.
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveSrtCliPath(): string {
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
  return path.join(path.dirname(entry), "cli.js");
}

const DISABLE_HINT = "To run the Agent CLIs without a sandbox, set backends.headless-core.sandbox to false.";

function assertSandboxAvailable(): void {
  if (process.platform === "win32") {
    throw new Error(
      "The srt sandbox is not supported on native Windows. Run Agent2API inside WSL2 instead; " +
        `see the README section 'Windows (WSL2)'. ${DISABLE_HINT}`
    );
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`The srt sandbox supports macOS and Linux, not ${process.platform}. ${DISABLE_HINT}`);
  }
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(`The srt sandbox is not supported on this platform. ${DISABLE_HINT}`);
  }
  const check = SandboxManager.checkDependencies();
  if (check.errors.length > 0) {
    const hint = process.platform === "linux" ? " Install them with e.g. `sudo apt install bubblewrap socat ripgrep`." : "";
    throw new Error(`The srt sandbox is missing dependencies: ${check.errors.join("; ")}.${hint} ${DISABLE_HINT}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
