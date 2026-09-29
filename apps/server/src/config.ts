import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  homeDir: string;
  dbPath: string;
  tmuxSocket: string;
  webDist: string;
  /** When set, all /api routes (except /api/auth/*) require this token cookie. */
  token: string | null;
  /**
   * Bearer token for machine callers of /api/notify (the shellboard-notify
   * CLI inside agent hooks). Always generated, persisted at
   * <homeDir>/notify-token (0600) so the CLI can read it without config.
   */
  notifyToken: string;
  /** User notify hooks (D8): every *.js/*.mjs here runs on a notify event. */
  notifyHooksDir: string;
  /** Hard kill timeout for one notify hook run. */
  notifyHookTimeoutMs: number;
  /** Extra origins allowed for WebSocket connections (dev: vite origin).
   * The vite dev server also derives server.allowedHosts from the same env. */
  allowedOrigins: string[];
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function loadConfig(): ServerConfig {
  const homeDir = process.env.SHELLBOARD_HOME ?? path.join(homedir(), ".shellboard");
  const extra = process.env.SHELLBOARD_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173";
  const host = process.env.SHELLBOARD_HOST ?? "127.0.0.1";
  let token: string | null = process.env.SHELLBOARD_TOKEN ?? null;
  // Mainstream self-hosted default (Jupyter, code-server): a shell exposed on
  // a non-loopback interface is never unauthenticated. Generate a token and
  // print it once instead of failing to start.
  if (!token && !isLoopbackHost(host)) {
    token = randomBytes(24).toString("base64url");
    console.warn(`[shellboard] ${host} is not a loopback address — token auth is enabled.`);
    console.warn(`[shellboard] access token: ${token}`);
    console.warn(`[shellboard] set SHELLBOARD_TOKEN to pin your own token.`);
  }
  return {
    port: Number(process.env.SHELLBOARD_PORT ?? 7700),
    host,
    homeDir,
    dbPath: process.env.SHELLBOARD_DB ?? path.join(homeDir, "shellboard.db"),
    tmuxSocket: process.env.SHELLBOARD_TMUX_SOCKET ?? "shellboard",
    webDist: process.env.SHELLBOARD_WEB_DIST ?? path.resolve(import.meta.dirname, "../../web/dist"),
    token,
    notifyToken: resolveNotifyToken(homeDir),
    notifyHooksDir: process.env.SHELLBOARD_NOTIFY_DIR ?? path.join(homeDir, "notify"),
    notifyHookTimeoutMs: clampHookTimeout(process.env.SHELLBOARD_NOTIFY_TIMEOUT_MS),
    allowedOrigins: extra
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  };
}

/**
 * The notify token is separate from the web session token: agent hooks are
 * non-interactive processes, so they authenticate with a token the server
 * persists to a 0600 file in the shellboard home — the CLI reads it back,
 * zero-config, in both loopback and token-auth deployments. Never logged.
 */
function resolveNotifyToken(homeDir: string): string {
  const tokenPath = path.join(homeDir, "notify-token");
  const pinned = process.env.SHELLBOARD_NOTIFY_TOKEN;
  if (pinned) {
    if (fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, "utf8").trim() === pinned) {
      return pinned;
    }
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(tokenPath, `${pinned}\n`, { mode: 0o600 });
    return pinned;
  }
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not persisted yet — generate below
  }
  const generated = randomBytes(24).toString("base64url");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function clampHookTimeout(raw: string | undefined): number {
  const value = Number(raw ?? 10000);
  if (!Number.isFinite(value)) return 10000;
  return Math.min(60000, Math.max(500, value));
}
