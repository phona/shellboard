import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll } from "vitest";
import type { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config";
import { buildServices, type Services } from "../src/services";

const cleanups: Array<() => Promise<void>> = [];

export async function createServices(): Promise<Services> {
  const config = loadConfig();
  const services = buildServices(config);
  cleanups.push(async () => {
    services.observer.stop();
    await services.tmux.killServer();
    services.db.close();
  });
  return services;
}

export function makeTempDir(prefix = "shellboard-fixture-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function createTestRepo(): Promise<string> {
  const dir = makeTempDir();
  await execa("git", ["init", "-b", "main", dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test"]);
  return dir;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await sleep(stepMs);
  }
}

/** Minimal double for the ws WebSocket surface the server code touches. */
export class FakeWS extends EventEmitter {
  readyState = 1;
  binary: Buffer[] = [];
  text: string[] = [];
  closed = false;
  closeCode: number | null = null;

  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) {
      this.binary.push(Buffer.from(data as ArrayBuffer));
    } else {
      this.text.push(String(data));
    }
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code ?? null;
    this.emit("close");
  }

  emitMessage(data: string | Buffer, isBinary = false): void {
    this.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary);
  }

  output(): string {
    return Buffer.concat(this.binary).toString("utf8");
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

export function afterAllCleanup(): void {
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });
}
