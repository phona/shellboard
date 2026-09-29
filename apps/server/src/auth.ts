import { createHash, timingSafeEqual } from "node:crypto";
import cookiePlugin from "@fastify/cookie";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { AuthLoginInputSchema } from "@shellboard/contracts";
import type { ServerConfig } from "./config.js";
import { httpError } from "./errors.js";
import { parseBody } from "./http/helpers.js";

export const AUTH_COOKIE = "sb_token";

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

export function requestAuthorized(request: IncomingMessage, config: ServerConfig): boolean {
  if (!config.token) return true;
  const header = request.headers.cookie;
  if (!header) return false;
  return parseCookieHeader(header).get(AUTH_COOKIE) === config.token;
}

/**
 * Machine callers (the shellboard-notify CLI inside agent hooks) authenticate
 * to /api/notify with the server-generated notify token as a bearer header.
 * Required even when cookie auth is off: a notify event triggers the user's
 * hook scripts, so a drive-by web page must not be able to POST it.
 */
export function notifyTokenAuthorized(
  request: { headers: { authorization?: string } },
  config: ServerConfig,
): boolean {
  const header = request.headers.authorization;
  if (!header) return false;
  const parts = header.split(" ", 2);
  const scheme = parts[0];
  const value = parts[1];
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") return false;
  return timingSafeEqual(tokenHash(value), tokenHash(config.notifyToken));
}

export function originAllowed(request: IncomingMessage, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser client
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // "host" is the direct Host header; "x-forwarded-host" is set by proxies
  // (e.g. the vite dev proxy) that rewrite Host to the upstream target.
  const hosts = [request.headers.host, request.headers["x-forwarded-host"]];
  for (const host of hosts) {
    if (typeof host !== "string") continue;
    const first = host.split(",")[0]?.trim();
    if (first && first === originHost) return true;
  }
  return config.allowedOrigins.includes(origin);
}

/** Token auth is opt-in via SHELLBOARD_TOKEN; off by default for localhost. */
export async function registerAuth(app: FastifyInstance, config: ServerConfig): Promise<void> {
  if (!config.token) return;
  await app.register(cookiePlugin);
  app.post("/api/auth/login", async (request, reply) => {
    const input = parseBody(AuthLoginInputSchema, request.body);
    if (!timingSafeEqual(tokenHash(input.token), tokenHash(config.token ?? ""))) {
      throw httpError(401, "invalid token");
    }
    reply.setCookie(AUTH_COOKIE, input.token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/")) return;
    if (request.cookies[AUTH_COOKIE] === config.token) return;
    const isNotify =
      request.url === "/api/notify" || request.url.startsWith("/api/notify?");
    if (isNotify && notifyTokenAuthorized(request, config)) return;
    return reply.code(401).send({ error: "unauthorized" });
  });
}
