import { createHash, timingSafeEqual } from "node:crypto";
import cookiePlugin from "@fastify/cookie";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { AuthLoginInputSchema } from "@shellboard/contracts";
import type { ServerConfig } from "./config.js";
import { httpError } from "./errors.js";
import { parseBody } from "./http/helpers.js";

export const AUTH_COOKIE = "sb_token";

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time token comparison; both sides are hashed to equal length.
 *  A missing value on either side never matches (an empty token means
 *  "auth off", which callers check before getting here). */
function tokenMatches(value: string | null | undefined, token: string | null | undefined): boolean {
  if (!value || !token) return false;
  return timingSafeEqual(tokenHash(value), tokenHash(token));
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
  return tokenMatches(parseCookieHeader(header).get(AUTH_COOKIE), config.token);
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

/** Loopback under any spelling a browser may put in an Origin. WHATWG URLs
    keep IPv6 literals bracketed, so the brackets are stripped first. */
function isLoopbackOriginHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.startsWith("127.") || host === "::1";
}

/** Hostname out of a Host / X-Forwarded-Host value ("host" or "host:port",
    IPv6 bracketed). */
function hostnameOf(hostPort: string): string {
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    return end === -1 ? hostPort : hostPort.slice(1, end);
  }
  const colon = hostPort.indexOf(":");
  return colon === -1 ? hostPort : hostPort.slice(0, colon);
}

/**
 * Whether a host can be DNS-rebound. Rebinding needs a NAME the attacker
 * controls DNS for, so it always involves a dotted public hostname. Two
 * host shapes are therefore immune and may pass a Host self-consistency
 * check: an IP literal (nothing to rebind) and a single-label name (public
 * DNS names always contain a dot; dotless resolution is mDNS / search
 * domain, i.e. LAN-local). Dotted names must be explicitly allowlisted.
 */
function reboundSafeHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return isIP(host) !== 0 || !host.includes(".");
}

/**
 * Origin policy, shared by the WebSocket upgrade path and the HTTP
 * cross-origin hook. Accepted, in order: no Origin at all (non-browser
 * client — curl, the notify CLI), an explicit allowlist entry (full origin,
 * or the bare host/domain the entry names), a Host self-consistency match
 * for a host DNS rebinding cannot use (IP literal or single-label name),
 * the address the connection actually landed on, or a loopback name with
 * the serving port.
 *
 * A DOTTED hostname is never accepted on self-consistency alone: the Host
 * header is set by the browser from the URL, so a page at evil.com whose
 * DNS is rebound to 127.0.0.1 sends Host and Origin both naming evil.com,
 * and that agreement proves nothing. Dotted names must be allowlisted
 * (SHELLBOARD_ALLOWED_ORIGINS).
 */
export function originAllowed(request: IncomingMessage, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser client
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(origin)) return true;
  // The allowlist is documented to also accept a bare domain, matched
  // against the origin's host with and without port.
  if (config.allowedOrigins.includes(url.hostname) || config.allowedOrigins.includes(url.host)) {
    return true;
  }
  // Host self-consistency, restricted to hosts DNS rebinding cannot use
  // (IP literal or single-label name — see reboundSafeHostname). This is
  // what makes plain LAN access work: a browser on another machine opens
  // http://192.168.100.10:5199 and its Origin names that IP, which no
  // allowlist covers and no header can vouch for. A rebound attacker page
  // sends a dotted hostname (evil.com) and fails this branch. The same
  // restriction applies to the proxy-forwarded header: vite copies the
  // browser's Host into it, so an unrestricted match there would reopen
  // the rebinding hole for dev-mode users.
  const originHostname = hostnameOf(url.host);
  if (reboundSafeHostname(originHostname)) {
    for (const header of [request.headers.host, request.headers["x-forwarded-host"]]) {
      if (typeof header !== "string") continue;
      const first = header.split(",")[0]?.trim();
      if (first && hostnameOf(first) === originHostname) return true;
    }
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  // The address this connection actually landed on. Covers LAN access to a
  // wildcard bind, where the browser origin is the machine's LAN IP and no
  // header can be trusted to say so.
  const socket = request.socket;
  if (
    socket &&
    port === socket.localPort &&
    socket.localAddress !== undefined &&
    url.hostname.replace(/^\[|\]$/g, "") === socket.localAddress.toLowerCase()
  ) {
    return true;
  }
  // Loopback spellings of the serving port: a browser reaching
  // http://localhost:7700 lands on 127.0.0.1, so address equality alone
  // would be too strict.
  return port === config.port && isLoopbackOriginHost(url.hostname);
}

/** Token auth is opt-in via SHELLBOARD_TOKEN; off by default for localhost. */
export async function registerAuth(app: FastifyInstance, config: ServerConfig): Promise<void> {
  // Runs with or without token auth: whatever the auth mode, a browser must
  // never be able to drive the API cross-origin (CSRF). Safe methods carry
  // no side effects; every other one must name an allowed Origin. Browser
  // requests always carry one; non-browser clients (curl, the notify CLI)
  // carry none and pass. This is the control the default no-token
  // deployment otherwise lacks entirely.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }
    if (originAllowed(request.raw, config)) return;
    return reply.code(403).send({ error: "origin not allowed" });
  });
  if (!config.token) return;
  await app.register(cookiePlugin);
  app.post("/api/auth/login", async (request, reply) => {
    const input = parseBody(AuthLoginInputSchema, request.body);
    if (!tokenMatches(input.token, config.token ?? "")) {
      throw httpError(401, "invalid token");
    }
    // Secure only when the client actually reached us over TLS: a loopback
    // or plain-HTTP LAN deployment would otherwise never store the cookie.
    const viaTls =
      request.headers["x-forwarded-proto"] === "https" || request.protocol === "https";
    reply.setCookie(AUTH_COOKIE, input.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: viaTls,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/")) return;
    if (tokenMatches(request.cookies[AUTH_COOKIE], config.token)) return;
    const isNotify =
      request.url === "/api/notify" || request.url.startsWith("/api/notify?");
    if (isNotify && notifyTokenAuthorized(request, config)) return;
    return reply.code(401).send({ error: "unauthorized" });
  });
}
