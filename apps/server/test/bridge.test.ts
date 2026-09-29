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

it("seeds the pane's history into a fresh attach (D7)", async () => {
  const { services, session } = await createBashSession();

  // Produce history through a first client, then leave.
  const first = new FakeWS();
  services.bridge.attach(first.asWebSocket(), session);
  await waitFor(() => first.output().length > 0);
  first.emitMessage("for i in $(seq 1 60); do echo seedline-$i; done\r", true);
  await waitFor(() => first.output().includes("seedline-60"));
  first.close();
  await sleep(300);

  // A fresh attach must receive the history above the current screen as its
  // first binary frames — before anything of the new screen.
  const second = new FakeWS();
  services.bridge.attach(second.asWebSocket(), session);
  await waitFor(() => second.output().includes("seedline-20"));
  const output = second.output();
  expect(output).toContain("seedline-20");
  // Lines must be CRLF-terminated: xterm.js has no ONLCR, so a bare LF from
  // capture-pane would continue each line at the current column (torn layout).
  expect(output).toContain("seedline-20\r\n");
  // The visible screen arrives as the attach repaint, i.e. after the seed.
  const seedEnd = output.indexOf("seedline-20");
  const repaint = output.indexOf("seedline-60");
  expect(repaint).toBeGreaterThan(seedEnd);

  second.close();
  await services.sessions.kill(session.id);
});

it("delivers arrow keys to alternate-screen apps as ordinary input", async () => {
  // The web client scrolls its local mirror for normal panes; for
  // alternate-screen apps it sends arrow keys as ORDINARY INPUT.
  const { services, dir, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  const startedFile = path.join(dir, "loop.started");
  const keysFile = path.join(dir, "keys.log");
  fs.writeFileSync(
    path.join(dir, "keys-app.sh"),
    [
      "printf '\\033[?1049h\\033[2J\\033[H'",
      `touch '${startedFile}'`,
      `while IFS= read -r -n1 -s c; do printf '%s' "$c" >> '${keysFile}'; done`,
    ].join("\n") + "\n",
  );
  ws.emitMessage(Buffer.from("bash\r"), true);
  ws.emitMessage(Buffer.from("echo bash-$((40+2))-ready\r"), true);
  await waitFor(() => ws.output().includes("bash-42-ready"));
  ws.emitMessage(Buffer.from(`bash '${path.join(dir, "keys-app.sh")}'\r`), true);
  await waitFor(() => fs.existsSync(startedFile));

  // Arrow keys ride the plain input path now — three Up keys reach the app.
  const keys = (): string => (fs.existsSync(keysFile) ? fs.readFileSync(keysFile, "utf8") : "");
  ws.emitMessage(Buffer.from("\x1b[A\x1b[A\x1b[A"), true);
  await waitFor(() => (keys().match(/\x1b(\[|O)A/g) ?? []).length >= 3);

  ws.close();
  await services.sessions.kill(session.id);
});
