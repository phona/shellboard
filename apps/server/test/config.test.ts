import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { isLoopbackHost, loadConfig } from "../src/config";

const saved = new Map(Object.entries(process.env));

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!saved.has(key)) delete process.env[key];
  }
  for (const [key, value] of saved) {
    process.env[key] = value;
  }
});

it("classifies loopback and non-loopback hosts", () => {
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("localhost")).toBe(true);
  expect(isLoopbackHost("::1")).toBe(true);
  expect(isLoopbackHost("0.0.0.0")).toBe(false);
  expect(isLoopbackHost("192.168.100.10")).toBe(false);
  expect(isLoopbackHost("mydevserver")).toBe(false);
});

it("auto-generates a token when binding a non-loopback address", () => {
  process.env.SHELLBOARD_HOST = "0.0.0.0";
  delete process.env.SHELLBOARD_TOKEN;
  const config = loadConfig();
  expect(typeof config.token).toBe("string");
  expect(config.token?.length).toBeGreaterThan(20);
});

it("stays unauthenticated on loopback without SHELLBOARD_TOKEN", () => {
  process.env.SHELLBOARD_HOST = "127.0.0.1";
  delete process.env.SHELLBOARD_TOKEN;
  expect(loadConfig().token).toBeNull();
});

it("honors an explicit SHELLBOARD_TOKEN on any host", () => {
  process.env.SHELLBOARD_HOST = "0.0.0.0";
  process.env.SHELLBOARD_TOKEN = "pinned-token";
  expect(loadConfig().token).toBe("pinned-token");
});

it("persists a stable notify token for the CLI", () => {
  process.env.SHELLBOARD_HOST = "127.0.0.1";
  delete process.env.SHELLBOARD_TOKEN;
  delete process.env.SHELLBOARD_NOTIFY_TOKEN;
  const first = loadConfig();
  const second = loadConfig();
  expect(first.notifyToken).toBe(second.notifyToken);
  const tokenPath = path.join(first.homeDir, "notify-token");
  expect((fs.statSync(tokenPath).mode & 0o777).toString(8)).toBe("600");
  expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe(first.notifyToken);
});

it("honors an explicit SHELLBOARD_NOTIFY_TOKEN", () => {
  process.env.SHELLBOARD_HOST = "127.0.0.1";
  process.env.SHELLBOARD_NOTIFY_TOKEN = "pinned-notify-token";
  expect(loadConfig().notifyToken).toBe("pinned-notify-token");
});
