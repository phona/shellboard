import nodePty from "node-pty";
import { expect, it } from "vitest";
import { wirePtyToSocket, type SeedPayload } from "../src/terminal/wire";
import { FakeWS, sleep, waitFor } from "./helpers";

it("resumes a real PTY after the WebSocket send queue drains", async () => {
  const pty = nodePty.spawn("/bin/cat", [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  const ws = new FakeWS();
  let bufferedAmount = 5 * 1024 * 1024;
  Object.defineProperty(ws, "bufferedAmount", { get: () => bufferedAmount });
  wirePtyToSocket(ws.asWebSocket(), pty, () => {});

  try {
    pty.write("before\r");
    await waitFor(() => ws.output().includes("before"));

    pty.write("after\r");
    await sleep(100);
    expect(ws.output()).not.toContain("after");

    bufferedAmount = 0;
    await waitFor(() => ws.output().includes("after"));
  } finally {
    ws.close();
    pty.kill();
  }
});

it("does not announce an omitted seed or carry its byte budget into the next hold", async () => {
  const pty = nodePty.spawn("/bin/sh", ["-c", "yes x | head -c 9000000; sleep 30"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  const ws = new FakeWS();
  let resolveSeed: (payload: SeedPayload) => void = () => {};
  const firstSeed = new Promise<SeedPayload>((resolve) => {
    resolveSeed = resolve;
  });
  let outputBytes = 0;
  pty.onData((data) => {
    outputBytes += data.length;
  });
  const handle = wirePtyToSocket(ws.asWebSocket(), pty, () => {}, {
    holdOutputUntil: firstSeed,
  });
  const payload = { seed: Buffer.from("seed marker\r\n"), lines: 1, complete: false };

  try {
    await waitFor(() => outputBytes > 8 * 1024 * 1024);
    resolveSeed(payload);
    await waitFor(() => ws.text.some((frame) => frame.includes("seed-skipped")));
    expect(ws.text.some((frame) => frame.includes("seed-start"))).toBe(false);
    expect(ws.output()).not.toContain("seed marker");

    handle.reseed(Promise.resolve(payload));
    await waitFor(() => ws.text.some((frame) => frame.includes("seed-start")));
    expect(ws.output()).toContain("seed marker");
  } finally {
    ws.close();
    pty.kill();
  }
}, 15_000);
