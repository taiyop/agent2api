import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS } from "@headless-core/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSrtSettings,
  prepareDirectLaunchers,
  prepareSrtSandbox,
  resolveExecutableReadPaths,
  SANDBOX_AGENT_IDS,
  type PreparedSandbox
} from "../../src/backends/headless-core/sandbox.js";

describe("sandbox coverage", () => {
  it("has a policy for every Agent headless_core can run, so none runs outside the sandbox", () => {
    expect([...SANDBOX_AGENT_IDS].sort()).toEqual([...AGENT_IDS].sort());
  });
});

describe("buildSrtSettings", () => {
  it("scopes each Agent to its own provider domains and state directories", () => {
    const claude = buildSrtSettings("claude", { type: "srt" }, "/work", {});
    expect(claude.network.allowedDomains).toEqual(expect.arrayContaining(["anthropic.com", "*.anthropic.com"]));
    expect(claude.network.allowedDomains).not.toContain("*.openai.com");
    expect(claude.filesystem.allowWrite).toEqual(["~/.claude", "~/.claude.json"]);
    expect(claude.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.ssh", "~/.codex", "~/.grok", "~/.gemini"]));
    expect(claude.filesystem.denyRead).not.toContain("~/.claude");
    expect(claude.enableWeakerNetworkIsolation).toBe(false);

    const codex = buildSrtSettings("codex", { type: "srt" }, "/work", {});
    expect(codex.network.allowedDomains).toEqual(expect.arrayContaining(["chatgpt.com", "*.openai.com"]));
    expect(codex.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.claude", "~/.claude.json"]));
    expect(codex.enableWeakerNetworkIsolation).toBe(true);

    const mistral = buildSrtSettings("mistral", { type: "srt" }, "/work", {}, { platform: "darwin" });
    expect(mistral.network.allowedDomains).toEqual(["mistral.ai", "*.mistral.ai", "mistral.services", "*.mistral.services"]);
    expect(mistral.filesystem.allowRead).toEqual(["/work", "~/.vibe", "~/.agents", "~/Library/Keychains"]);
    expect(mistral.filesystem.allowWrite).toEqual(["~/.vibe"]);
    expect(buildSrtSettings("mistral", { type: "srt" }, "/work", { VIBE_HOME: "/vibe" }).filesystem.allowWrite).toEqual(["/vibe"]);
    expect(claude.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.vibe", "~/.local/share/devin", "~/.config/devin"]));

    const devin = buildSrtSettings("devin", { type: "srt" }, "/work", {}, { platform: "darwin" });
    expect(devin.network.allowedDomains).toEqual(expect.arrayContaining(["devin.ai", "*.devin.ai", "*.codeium.com", "*.windsurf.com"]));
    expect(devin.filesystem.allowRead).toEqual(["/work", "~/.local/share/devin", "~/.config/devin"]);
    expect(devin.filesystem.allowWrite).toEqual(["~/.local/share/devin", "~/.config/devin"]);
    expect(devin.enableWeakerNetworkIsolation).toBe(true);
    expect(buildSrtSettings("devin", { type: "srt" }, "/work", { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf" })
      .filesystem.allowWrite).toEqual(["/data/devin", "/conf/devin"]);
  });

  it("denies reads under the home directory and mounted volumes except an allowlist", () => {
    const claude = buildSrtSettings("claude", { type: "srt" }, "/work", {}, {
      executablePaths: ["/home/u/.local/bin/claude"],
      platform: "darwin"
    });
    expect(claude.filesystem.denyRead).toEqual(expect.arrayContaining(["~", "/Volumes", "/mnt", "/media"]));
    expect(claude.filesystem.allowRead).toEqual([
      "/work", "~/.claude", "~/.claude.json", "/home/u/.local/bin/claude", "~/Library/Keychains"
    ]);
    expect(buildSrtSettings("claude", { type: "srt" }, "/work", {}, { platform: "linux" }).filesystem.allowRead)
      .not.toContain("~/Library/Keychains");
    expect(buildSrtSettings("codex", { type: "srt" }, "/work", {}, { platform: "darwin" }).filesystem.allowRead)
      .toEqual(["/work", "~/.codex"]);
    expect(buildSrtSettings("grok", {
      type: "srt",
      filesystem: { allowRead: ["/shared"] },
      agents: { grok: { filesystem: { allowRead: ["/grok-only"] } } }
    }, "/work", {}, { platform: "linux" }).filesystem.allowRead).toEqual(["/work", "~/.grok", "/shared", "/grok-only"]);
  });

  it("lets only Agy write the workspace and never allows local binding by default", () => {
    const agy = buildSrtSettings("agy", { type: "srt" }, "/work", {});
    expect(agy.filesystem.allowWrite).toContain("/work");
    for (const agent of ["claude", "codex", "grok", "devin", "mistral"] as const) {
      expect(buildSrtSettings(agent, { type: "srt" }, "/work", {}).filesystem.allowWrite).not.toContain("/work");
    }
    for (const agent of ["claude", "codex", "grok", "agy", "devin", "mistral"] as const) {
      expect(buildSrtSettings(agent, { type: "srt" }, "/work", {}).network.allowLocalBinding).toBe(false);
    }
  });

  it("allows local binding only for an Agent that opts in", () => {
    const config = { type: "srt" as const, agents: { agy: { network: { allowLocalBinding: true } } } };
    expect(buildSrtSettings("agy", config, "/work", {}).network.allowLocalBinding).toBe(true);
    expect(buildSrtSettings("claude", config, "/work", {}).network.allowLocalBinding).toBe(false);
  });

  it("follows CODEX_HOME and CLAUDE_CONFIG_DIR", () => {
    const env = { CODEX_HOME: "/state/codex", CLAUDE_CONFIG_DIR: "/state/claude" };
    expect(buildSrtSettings("codex", { type: "srt" }, "/work", env).filesystem.allowWrite).toEqual(["/state/codex"]);
    expect(buildSrtSettings("claude", { type: "srt" }, "/work", env).filesystem.allowWrite).toEqual(["/state/claude"]);
    expect(buildSrtSettings("grok", { type: "srt" }, "/work", env).filesystem.denyRead)
      .toEqual(expect.arrayContaining(["/state/codex", "/state/claude"]));
  });

  it("appends shared and per-Agent lists and lets the Agent entry override booleans", () => {
    const settings = buildSrtSettings("agy", {
      type: "srt",
      network: { allowedDomains: ["shared.example"], deniedDomains: ["bad.example"] },
      filesystem: { denyRead: ["/secret"], allowWrite: ["/out"] },
      enableWeakerNetworkIsolation: false,
      agents: {
        agy: {
          network: { allowedDomains: ["lh3.googleusercontent.com"], allowLocalBinding: true },
          filesystem: { denyWrite: ["/work/.env"] },
          enableWeakerNetworkIsolation: true
        }
      }
    }, "/work", {});
    expect(settings.network.allowedDomains).toEqual(expect.arrayContaining([
      "*.googleapis.com", "shared.example", "lh3.googleusercontent.com"
    ]));
    expect(settings.network.deniedDomains).toEqual(["bad.example"]);
    expect(settings.network.allowLocalBinding).toBe(true);
    expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.ssh", "/secret"]));
    expect(settings.filesystem.allowWrite).toEqual(expect.arrayContaining(["~/.gemini", "/work", "/out"]));
    expect(settings.filesystem.denyWrite).toEqual(["/work/.env"]);
    expect(settings.enableWeakerNetworkIsolation).toBe(true);
  });
});

describe("resolveExecutableReadPaths", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("follows PATH and links to the real binary", () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent2api-exe-")));
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "versions"));
    const real = path.join(root, "versions", "1.0.0");
    writeFileSync(real, "binary", { mode: 0o755 });
    symlinkSync(real, path.join(root, "current"));
    symlinkSync(path.join(root, "current"), path.join(root, "bin", "tool"));
    expect(resolveExecutableReadPaths("tool", { PATH: `/nonexistent${path.delimiter}${path.join(root, "bin")}` }))
      .toEqual([path.join(root, "bin", "tool"), path.join(root, "current"), real]);
    expect(resolveExecutableReadPaths("missing-tool", { PATH: path.join(root, "bin") })).toEqual([]);
  });

  it("keeps every match on PATH readable, so a wrapper in front can run the real binary", () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent2api-exe-")));
    mkdirSync(path.join(root, "shims"));
    mkdirSync(path.join(root, "bin"));
    const shim = path.join(root, "shims", "tool");
    writeFileSync(shim, "#!/bin/bash\nexec tool \"$@\"\n", { mode: 0o755 });
    const real = path.join(root, "bin", "tool");
    writeFileSync(real, "binary", { mode: 0o755 });
    const paths = resolveExecutableReadPaths("tool", {
      PATH: [path.join(root, "shims"), path.join(root, "bin")].join(path.delimiter)
    });
    expect(paths).toEqual(expect.arrayContaining([shim, "/bin/bash", real]));
    expect(paths.indexOf(shim)).toBeLessThan(paths.indexOf(real));
  });

  it("adds a script's package directory and its interpreter", () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent2api-exe-")));
    const packageDir = path.join(root, "lib", "node_modules", "tool");
    mkdirSync(path.join(packageDir, "bin"), { recursive: true });
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(packageDir, "package.json"), "{}");
    const script = path.join(packageDir, "bin", "tool.js");
    writeFileSync(script, "#!/usr/bin/env -S node --no-warnings\n", { mode: 0o755 });
    const node = path.join(root, "bin", "node");
    writeFileSync(node, "binary", { mode: 0o755 });
    symlinkSync(script, path.join(root, "bin", "tool"));
    expect(resolveExecutableReadPaths("tool", { PATH: path.join(root, "bin") }))
      .toEqual([path.join(root, "bin", "tool"), script, packageDir, node]);
  });

  it("adds a Python virtual environment and the base installation it was created from", () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent2api-exe-")));
    const base = path.join(root, "python", "cpython-3.14.5");
    mkdirSync(path.join(base, "bin"), { recursive: true });
    symlinkSync(base, path.join(root, "python", "cpython-3.14"));
    const venv = path.join(root, "tools", "tool");
    mkdirSync(path.join(venv, "bin"), { recursive: true });
    writeFileSync(path.join(venv, "pyvenv.cfg"), `home = ${path.join(root, "python", "cpython-3.14", "bin")}\n`);
    const python = path.join(venv, "bin", "python3");
    writeFileSync(python, "binary", { mode: 0o755 });
    const script = path.join(venv, "bin", "tool");
    writeFileSync(script, `#!${python}\n`, { mode: 0o755 });
    mkdirSync(path.join(root, "bin"));
    symlinkSync(script, path.join(root, "bin", "tool"));
    expect(resolveExecutableReadPaths("tool", { PATH: path.join(root, "bin") })).toEqual([
      path.join(root, "bin", "tool"), script, venv, path.join(root, "python", "cpython-3.14"), base, python
    ]);
  });
});

describe("prepareSrtSandbox", () => {
  let sandbox: PreparedSandbox | undefined;
  let scratch: string | undefined;

  afterEach(() => {
    sandbox?.dispose();
    sandbox = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  function fakeSrt(): string {
    scratch = mkdtempSync(path.join(os.tmpdir(), "agent2api-fake-srt-"));
    const script = path.join(scratch, "fake-srt.mjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    return script;
  }

  it("points every Agent binary at a wrapper that runs it through srt with exact arguments", () => {
    sandbox = prepareSrtSandbox({
      config: { type: "srt" },
      cwd: "/work",
      env: { PATH: process.env.PATH, CLAUDE_BIN: "/opt/claude's bin/claude", AGY_ACP_BIN: "/opt/agy/agy_acp_server" },
      srtCliPath: fakeSrt(),
      skipDependencyCheck: true
    });

    // The CLIs, and the separate programs the persistent transports start.
    for (const variable of ["CODEX_BIN", "CLAUDE_BIN", "GROK_BIN", "AGY_BIN", "DEVIN_BIN", "VIBE_BIN", "CLAUDE_SDK_BIN", "AGY_ACP_BIN", "VIBE_ACP_BIN"]) {
      expect(sandbox.env[variable]).toMatch(new RegExp(`^${escapeRegExp(sandbox.directory)}/`));
    }
    const prompt = `-p it's "$HOME" \`whoami\` $(id)\nline two`;
    const codexArgs = JSON.parse(execFileSync(sandbox.env.CODEX_BIN!, ["exec", "--sandbox", "read-only", prompt], { encoding: "utf8" }));
    const settingsPath = path.join(sandbox.directory, "codex.srt-settings.json");
    // codex starts without the user's hooks, which can keep an app-server turn from completing.
    expect(codexArgs).toEqual(["--settings", settingsPath, "--", "codex", "--disable", "hooks", "exec", "--sandbox", "read-only", prompt]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(sandbox.settings.codex);

    const claudeArgs = JSON.parse(execFileSync(sandbox.env.CLAUDE_BIN!, ["--print"], { encoding: "utf8" }));
    expect(claudeArgs.slice(2)).toEqual(["--", "/opt/claude's bin/claude", "--print"]);

    const vibeArgs = JSON.parse(execFileSync(sandbox.env.VIBE_BIN!, ["--agent", "ask"], { encoding: "utf8" }));
    expect(vibeArgs).toEqual(["--settings", path.join(sandbox.directory, "mistral.srt-settings.json"), "--", "vibe", "--agent", "ask"]);

    // The Claude Agent SDK runs the installed claude, under the claude policy.
    const sdkArgs = JSON.parse(execFileSync(sandbox.env.CLAUDE_SDK_BIN!, ["--output-format", "stream-json"], { encoding: "utf8" }));
    expect(sdkArgs).toEqual(["--settings", path.join(sandbox.directory, "claude.srt-settings.json"), "--", "/opt/claude's bin/claude", "--output-format", "stream-json"]);
    const agyAcpArgs = JSON.parse(execFileSync(sandbox.env.AGY_ACP_BIN!, [], { encoding: "utf8" }));
    expect(agyAcpArgs).toEqual(["--settings", path.join(sandbox.directory, "agy.srt-settings.json"), "--", "/opt/agy/agy_acp_server"]);
    const vibeAcpArgs = JSON.parse(execFileSync(sandbox.env.VIBE_ACP_BIN!, [], { encoding: "utf8" }));
    expect(vibeAcpArgs).toEqual(["--settings", path.join(sandbox.directory, "mistral.srt-settings.json"), "--", "vibe-acp"]);
  });

  it("starts the Agents the same way without a sandbox", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "agent2api-direct-"));
    scratch = bin;
    for (const name of ["claude", "codex"]) {
      writeFileSync(path.join(bin, name), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    }
    const launchers = prepareDirectLaunchers({ PATH: bin });
    try {
      expect(execFileSync(launchers.env.CODEX_BIN!, ["exec", "hi"], { encoding: "utf8", env: { PATH: bin } })).toBe("--disable\nhooks\nexec\nhi\n");
      expect(launchers.env.CLAUDE_SDK_BIN).toBe(path.join(bin, "claude"));
      expect(launchers.env.CLAUDE_BIN).toBeUndefined();
    } finally {
      launchers.dispose();
    }
  });

  it("refuses to start on native Windows and points to WSL2", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(() => prepareSrtSandbox({ config: { type: "srt" }, cwd: "/work", srtCliPath: fakeSrt() }))
        .toThrowError(/WSL2.*sandbox to false/);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("refuses a working directory that contains the home directory", () => {
    for (const cwd of ["/home/u", "/home", "/"]) {
      expect(() => prepareSrtSandbox({
        config: { type: "srt" }, cwd, env: { HOME: "/home/u" }, srtCliPath: fakeSrt(), skipDependencyCheck: true
      })).toThrowError(/contains the home directory/);
    }
  });

  it("removes the generated files on dispose", () => {
    sandbox = prepareSrtSandbox({ config: { type: "srt" }, cwd: "/work", srtCliPath: fakeSrt(), skipDependencyCheck: true });
    const directory = sandbox.directory;
    expect(existsSync(path.join(directory, "agy"))).toBe(true);
    sandbox.dispose();
    expect(existsSync(directory)).toBe(false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
