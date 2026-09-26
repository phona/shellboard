import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { originAllowed } from "../src/auth";

const config = { ...loadConfig(), allowedOrigins: [] };

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

it("allows same-host origins and non-browser clients", () => {
  expect(originAllowed(request({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173" }), config)).toBe(true);
  expect(originAllowed(request({}), config)).toBe(true);
});

it("rejects cross-site origins without proxy forwarding", () => {
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
});

it("honors the configured allowlist", () => {
  const allowlist = { ...config, allowedOrigins: ["https://shell.example.com"] };
  expect(
    originAllowed(request({ origin: "https://shell.example.com", host: "127.0.0.1:7700" }), allowlist),
  ).toBe(true);
});
