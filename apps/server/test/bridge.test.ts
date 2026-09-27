import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
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

it("drives tmux scrollback through the scroll channel and pushes OSC 52", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  // make the scrollback scrollable
  ws.emitMessage(Buffer.from("seq 1 500\r"), true);
  await sleep(800);
  const { execa } = await import("execa");
  const paneInMode = async (): Promise<string> => {
    const result = await execa(
      "tmux",
      ["-L", services.config.tmuxSocket, "display-message", "-p", "-t", session.tmuxName, "#{pane_in_mode}"],
    );
    return result.stdout.trim();
  };

  // wheel up enters copy-mode and scrolls
  services.tmux.scroll(session.tmuxName, 10);
  await sleep(700);
  expect(await paneInMode()).toBe("1");

  // wheel back down to the bottom exits copy-mode
  services.tmux.scroll(session.tmuxName, -10);
  await sleep(600);
  expect(await paneInMode()).toBe("0");

  // OSC 52 still flows: set-buffer -w pushes the buffer to the outer
  // clipboard (tmux copy commands and inner CLIs rely on this)
  await execa(
    "tmux",
    ["-L", services.config.tmuxSocket, "set-buffer", "-w", "sb-osc52-marker"],
  );
  await waitFor(() => ws.output().includes("]52;"), 10000);
  ws.close();
  await services.sessions.kill(session.id);
});

it("translates scroll into arrow keys for alternate-screen panes (DECSET 1007)", async () => {
  const { services, dir, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  // A stand-in for the Codex TUI (0.157+ runs fullscreen): a script that
  // switches to the alternate screen and appends every received key to a
  // file. The per-key append matters — a plain `cat -v > file` sits in its
  // 4KB stdio buffer. The reader runs under explicit bash: the session
  // shell is $SHELL and `read -n1` is a bash builtin.
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
  // The marker arithmetic keeps the gate honest: the tty echo contains the
  // literal `$((40+2))`, so only real execution produces "bash-42-ready".
  ws.emitMessage(Buffer.from("bash\r"), true);
  ws.emitMessage(Buffer.from("echo bash-$((40+2))-ready\r"), true);
  await waitFor(() => ws.output().includes("bash-42-ready"));
  ws.emitMessage(Buffer.from(`bash '${path.join(dir, "keys-app.sh")}'\r`), true);
  // The started marker proves the loop reached its read: scroll keys sent
  // earlier could otherwise land in bash's line editor instead.
  await waitFor(() => fs.existsSync(startedFile));

  const paneInMode = async (): Promise<string> => {
    const result = await execa(
      "tmux",
      ["-L", services.config.tmuxSocket, "display-message", "-p", "-t", session.tmuxName, "#{pane_in_mode}"],
    );
    return result.stdout.trim();
  };

  // Wheel up must reach the app as Up keys; the pane keeps no copy-mode for
  // an alternate-screen app to scroll (it has no tmux history at all).
  const keys = (): string => (fs.existsSync(keysFile) ? fs.readFileSync(keysFile, "utf8") : "");
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: 3 })), false);
  await waitFor(() => (keys().match(/\x1b(\[|O)A/g) ?? []).length >= 3);
  expect(await paneInMode()).toBe("0");

  // Scroll down = Down keys, and no copy-mode control traffic: after tmux
  // confirmed the alternate screen the optimistic copy-mode arming is off.
  const framesBefore = ws.text.length;
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: -2 })), false);
  await waitFor(() => (keys().match(/\x1b(\[|O)B/g) ?? []).length >= 2);
  expect(
    ws.text
      .slice(framesBefore)
      .filter((frame) => frame.includes("copy-mode")),
  ).toEqual([]);

  ws.close();
  await services.sessions.kill(session.id);
});

it("exits copy-mode on user input and on scroll-bottom", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  // produce scrollable history, then scroll up via the scroll channel
  ws.emitMessage(Buffer.from("seq 1 500\r"), true);
  await sleep(800);
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: 10 })), false);
  await sleep(700);
  const paneInMode = async (): Promise<string> => {
    const result = await execa(
      "tmux",
      ["-L", services.config.tmuxSocket, "display-message", "-p", "-t", session.tmuxName, "#{pane_in_mode}"],
    );
    return result.stdout.trim();
  };
  expect(await paneInMode()).toBe("1");

  // typing must cancel copy-mode first, then reach the shell
  ws.emitMessage(Buffer.from("echo im-live-$((40+2))\r"), true);
  await waitFor(() => ws.output().includes("im-live-42"), 10000);
  expect(await paneInMode()).toBe("0");

  // scroll up again, then Ctrl+End (scroll-bottom) returns to live
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: 10 })), false);
  await sleep(700);
  expect(await paneInMode()).toBe("1");
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll-bottom" })), false);
  await sleep(700);
  expect(await paneInMode()).toBe("0");

  ws.close();
  await services.sessions.kill(session.id);
});

it("clears history mode when scrolling back to the bottom", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  services.bridge.attach(ws.asWebSocket(), session);
  await waitFor(() => ws.output().length > 0);

  ws.emitMessage(Buffer.from("seq 1 500\r"), true);
  await sleep(800);
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: 10 })), false);
  await sleep(700);
  const paneInMode = async (): Promise<string> => {
    const result = await execa(
      "tmux",
      ["-L", services.config.tmuxSocket, "display-message", "-p", "-t", session.tmuxName, "#{pane_in_mode}"],
    );
    return result.stdout.trim();
  };
  expect(await paneInMode()).toBe("1");

  // scrolling back to the bottom must exit copy-mode AND tell the client,
  // so the HISTORY pill hides itself
  ws.emitMessage(Buffer.from(JSON.stringify({ type: "scroll", lines: -10 })), false);
  await sleep(700);
  expect(await paneInMode()).toBe("0");
  expect(
    ws.text.some((frame) => frame.includes('"copy-mode"') && frame.includes('"active":false')),
  ).toBe(true);

  ws.close();
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
