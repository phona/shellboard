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

export function originAllowed(request: IncomingMessage, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser client
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = request.headers.host;
  if (host && originHost === host) return true;
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
    return reply.code(401).send({ error: "unauthorized" });
  });
}
