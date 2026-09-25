import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { afterAllCleanup, createServices, FakeWS, makeTempDir, sleep, waitFor } from "./helpers";

afterAllCleanup();

let counter = 0;

async function createBashSession() {
  const services = await createServices();
  counter += 1;
  const dir = makeTempDir();
  const project = services.projects.create({
    name: `bridge-proj-${counter}`,
    rootPath: dir,
  });
  const created = await services.sessions.create({
    projectId: project.id,
    name: `bridge-${counter}`,
    agentType: "shell",
  });
  return { services, dir, session: created.session };
}

it("keeps the shell alive when the browser disconnects (D5)", async () => {
  const { services, dir, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);

  await waitFor(() => ws.output().length > 0);

  // Production clients send keystrokes as binary frames.
  ws.emitMessage("echo hello > marker.txt\r", true);
  await sleep(600);
  ws.close();

  await sleep(200);
  // The tmux session (and therefore the "agent") must survive the disconnect.
  expect(await services.tmux.sessionExists(session.tmuxName)).toBe(true);
  expect(fs.existsSync(path.join(dir, "marker.txt"))).toBe(true);

  // Reattach works and the service is still the same tmux session.
  const ws2 = new FakeWS();
  services.bridge.attach(ws2.asWebSocket(), session);
  await waitFor(() => ws2.output().length > 0);
  ws2.emitMessage("echo done\r", true);
  await sleep(300);
  ws2.close();

  await services.sessions.kill(session.id);
});

it("kills only the tmux client on disconnect, not the session", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);
  await services.observer.tick(); // liveness comes from tmux observation

  ws.close();
  await sleep(200);
  await services.observer.tick();
  const runtime = services.tracker.get(session.id);
  expect(runtime.attachedClients).toBe(0);
  expect(runtime.alive).toBe(true);

  await services.sessions.kill(session.id);
});

it("takes over an existing client instead of sharing the PTY (D4)", async () => {
  const { services, session } = await createBashSession();
  const first = new FakeWS();
  services.bridge.attach(first.asWebSocket(), session);
  await waitFor(() => first.output().length > 0);

  const second = new FakeWS();
  services.bridge.attach(second.asWebSocket(), session);

  await waitFor(() => first.closeCode !== null);
  expect(first.closeCode).toBe(4001);
  expect(first.text.join("")).toContain("taken-over");
  await waitFor(() => second.output().length > 0);

  const runtime = services.tracker.get(session.id);
  expect(runtime.attachedClients).toBe(1);

  second.close();
  await sleep(100);
  expect(await services.tmux.sessionExists(session.tmuxName)).toBe(true);
  await services.sessions.kill(session.id);
});

it("forwards keystrokes through to the running shell", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  ws.emitMessage("echo forward-$((21+21))\r", true);
  await waitFor(() => ws.output().includes("forward-42"));
  ws.close();

  await services.sessions.kill(session.id);
});
