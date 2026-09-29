import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { originAllowed } from "../src/auth";

const config = { ...loadConfig(), port: 7700, allowedOrigins: [] };

function request(
  headers: Record<string, string>,
  socket?: { localAddress: string; localPort: number },
): IncomingMessage {
  return { headers, socket } as unknown as IncomingMessage;
}

it("allows non-browser clients and loopback origins on the serving port", () => {
  expect(originAllowed(request({}), config)).toBe(true);
  expect(originAllowed(request({ origin: "http://127.0.0.1:7700" }), config)).toBe(true);
  expect(originAllowed(request({ origin: "http://localhost:7700" }), config)).toBe(true);
  expect(originAllowed(request({ origin: "http://[::1]:7700" }), config)).toBe(true);
});

it("allows an origin that names the address the connection landed on", () => {
  // LAN access to a wildcard bind: the browser origin is the machine's LAN
  // IP, and no request header can be trusted to say so.
  expect(
    originAllowed(
      request(
        { origin: "http://192.168.1.20:7700" },
        { localAddress: "192.168.1.20", localPort: 7700 },
      ),
      config,
    ),
  ).toBe(true);
  // Same host, wrong port: a different service on the box must not pass.
  expect(
    originAllowed(
      request(
        { origin: "http://192.168.1.20:9999" },
        { localAddress: "192.168.1.20", localPort: 7700 },
      ),
      config,
    ),
  ).toBe(false);
});

it("rejects a rebound origin even when the Host header agrees with it", () => {
  // evil.com rebound to 127.0.0.1: the browser sends Host and Origin both
  // naming evil.com. The old Host self-consistency check accepted this.
  expect(
    originAllowed(
      request({ origin: "http://evil.example:7700", host: "evil.example:7700" }),
      config,
    ),
  ).toBe(false);
});

it("accepts Host self-consistency for hosts rebinding cannot use", () => {
  // Plain LAN access: a browser on another machine opens the vite dev
  // server by IP; its Origin names that IP and nothing else can vouch
  // for it. IP literals cannot be rebound.
  expect(
    originAllowed(
      request({ origin: "http://192.168.100.10:5199", host: "192.168.100.10:5199" }),
      config,
    ),
  ).toBe(true);
  // Single-label LAN names: public DNS names always contain a dot, so a
  // dotless name can only resolve via mDNS / search domain — LAN-local.
  expect(
    originAllowed(
      request({ origin: "http://mymac:5199", host: "mymac:5199" }),
      config,
    ),
  ).toBe(true);
  // A dotted name must never pass on self-consistency alone, even behind
  // the vite proxy's forwarded-host header (vite copies the browser Host).
  expect(
    originAllowed(
      request({
        origin: "http://mymac.local:5199",
        host: "mymac.local:5199",
        "x-forwarded-host": "mymac.local:5199",
      }),
      config,
    ),
  ).toBe(false);
});

it("rejects cross-site origins", () => {
  expect(
    originAllowed(request({ origin: "http://evil.example:8080", host: "127.0.0.1:7700" }), config),
  ).toBe(false);
});

it("accepts origins forwarded by the vite dev proxy (x-forwarded-host)", () => {
  expect(
    originAllowed(
      request({
        origin: "http://192.168.1.20:5173",
        host: "127.0.0.1:7700",
        "x-forwarded-host": "192.168.1.20:5173",
      }),
      config,
    ),
  ).toBe(true);
  // A forwarded host that disagrees with the origin is not a pass.
  expect(
    originAllowed(
      request({
        origin: "http://evil.example:5173",
        host: "127.0.0.1:7700",
        "x-forwarded-host": "192.168.1.20:5173",
      }),
      config,
    ),
  ).toBe(false);
});

it("honors the configured allowlist (full origin and bare domain)", () => {
  const allowlist = { ...config, allowedOrigins: ["https://shell.example.com", "board.internal"] };
  expect(
    originAllowed(request({ origin: "https://shell.example.com", host: "127.0.0.1:7700" }), allowlist),
  ).toBe(true);
  expect(
    originAllowed(request({ origin: "https://board.internal:8443", host: "127.0.0.1:7700" }), allowlist),
  ).toBe(true);
  expect(
    originAllowed(request({ origin: "https://other.example.com", host: "127.0.0.1:7700" }), allowlist),
  ).toBe(false);
});
