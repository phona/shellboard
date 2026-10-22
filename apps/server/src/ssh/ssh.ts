import path from "node:path";
import type { EnvVarMap, ProjectLocation } from "@shellboard/contracts";
import { httpError } from "../errors.js";

export interface SshOptions {
  connectTimeoutSeconds: number;
  serverAliveIntervalSeconds: number;
  serverAliveCountMax: number;
}

const MAX_ENCODED_COMMAND_CHARS = 7600;

/** Shellboard's target shell is Windows PowerShell. PowerShell single quoted
    strings escape a quote by doubling it. The complete script is then encoded
    as UTF-16LE so neither the local tmux shell nor the SSH remote command
    parser can reinterpret paths, env values, or argv. */
function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powershellEncoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeWindowsPath(value: string): string {
  const remotePath = value.trim();
  if (!isWindowsAbsolutePath(remotePath)) {
    throw httpError(400, "remote path must be an absolute Windows path");
  }
  return remotePath;
}

function validateIdentityFile(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw httpError(400, "identityFile must be an absolute local path");
  }
  return value;
}

function remoteScript(
  remoteCwd: string,
  command: string[],
  env: EnvVarMap,
  interactiveShell: boolean,
): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path -LiteralPath ${powershellQuote(remoteCwd)} -PathType Container)) { [Console]::Error.WriteLine('remote cwd is not a directory'); exit 2 }`,
    `Set-Location -LiteralPath ${powershellQuote(remoteCwd)}`,
    "[System.Environment]::CurrentDirectory = $PWD.ProviderPath",
    ...Object.keys(env)
      .sort()
      .map((key) => `$env:${key} = ${powershellQuote(env[key] ?? "")}`),
  ];
  if (!interactiveShell) {
    const commandName = command[0] ?? "";
    lines.push(
      `$agentCommand = ${powershellQuote(commandName)}`,
      "if (-not (Test-Path -LiteralPath $agentCommand -PathType Leaf) -and -not (Get-Command $agentCommand -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('agent command was not found: ' + $agentCommand); exit 127 }",
      `& $agentCommand${command
        .slice(1)
        .map((arg) => ` ${powershellQuote(arg)}`)
        .join("")}`,
      "exit $LASTEXITCODE",
    );
  }
  return lines.join("\n");
}

export class SshService {
  private readonly options: SshOptions;
  /** A Windows remote path must never become node-pty's local cwd. */
  readonly localRuntimeCwd: string;

  constructor(options: SshOptions, localRuntimeCwd: string) {
    this.options = options;
    this.localRuntimeCwd = localRuntimeCwd;
  }

  private baseArgs(location: Extract<ProjectLocation, { kind: "ssh" }>): string[] {
    const args = [
      "-F",
      "/dev/null",
      "-p",
      String(location.port),
      "-l",
      location.username,
      "-o",
      `ConnectTimeout=${this.options.connectTimeoutSeconds}`,
      "-o",
      `ServerAliveInterval=${this.options.serverAliveIntervalSeconds}`,
      "-o",
      `ServerAliveCountMax=${this.options.serverAliveCountMax}`,
      "-o",
      "EscapeChar=none",
    ];
    if (location.auth.kind === "key") {
      args.push("-o", "PreferredAuthentications=publickey");
      if (location.auth.identityFile) {
        args.push("-i", validateIdentityFile(location.auth.identityFile), "-o", "IdentitiesOnly=yes");
      }
    } else {
      args.push("-o", "PreferredAuthentications=password,keyboard-interactive");
    }
    return args;
  }

  private commandArgs(
    location: Extract<ProjectLocation, { kind: "ssh" }>,
    script: string,
    tty: boolean,
    interactiveShell: boolean,
  ): string[] {
    const encodedScript = powershellEncoded(script);
    if (encodedScript.length > MAX_ENCODED_COMMAND_CHARS) {
      throw httpError(400, "remote launch command is too long for Windows OpenSSH");
    }
    return [
      ...(tty ? ["-tt"] : ["-T"]),
      ...this.baseArgs(location),
      location.host,
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      ...(interactiveShell ? ["-NoExit"] : []),
      "-EncodedCommand",
      encodedScript,
    ];
  }

  buildAgentCommand(
    location: Extract<ProjectLocation, { kind: "ssh" }>,
    remoteCwd: string,
    command: string[],
    env: EnvVarMap,
    interactiveShell = false,
  ): string[] {
    return [
      "ssh",
      ...this.commandArgs(
        location,
        remoteScript(remoteCwd, command, env, interactiveShell),
        true,
        interactiveShell,
      ),
    ];
  }
}
