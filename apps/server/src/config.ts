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
  /** Extra origins allowed for WebSocket connections (dev: vite origin). */
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
    allowedOrigins: extra
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  };
}
