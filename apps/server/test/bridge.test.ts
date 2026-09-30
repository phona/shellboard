import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import type { Session } from "@shellboard/contracts";
import type { Services } from "../src/services";
import { dropTrailingLineFeed } from "../src/terminal/bridge";
import { afterAllCleanup, createServices, FakeWS, makeTempDir, sleep, waitFor } from "./helpers";

afterAllCleanup();

describe("dropTrailingLineFeed (screen-inclusive seed)", () => {
  // The CRLF rewrite in normalizeSeedLineEndings turns a trailing LF into a
  // scroll, which would shift a screen-inclusive seed up by one row. That
  // off-by-one is what starts the drift cascade.
  it("drops a trailing LF", () => {
    expect(dropTrailingLineFeed(Buffer.from("a\r\nb\r\n")).toString()).toBe("a\r\nb");
  });

  it("drops a trailing CRLF pair", () => {
    expect(dropTrailingLineFeed(Buffer.from("a\r\nb\r\n")).toString()).toBe("a\r\nb");
  });

  it("leaves a seed with no trailing line feed alone", () => {
    expect(dropTrailingLineFeed(Buffer.from("a\r\nb")).toString()).toBe("a\r\nb");
    expect(dropTrailingLineFeed(Buffer.from("a\r\n")).toString()).toBe("a");
  });

  it("handles an empty seed", () => {
    expect(dropTrailingLineFeed(Buffer.alloc(0)).toString()).toBe("");
  });

  it("only removes one line feed, not the content", () => {
    expect(dropTrailingLineFeed(Buffer.from("a\n\n")).toString()).toBe("a\n");
  });

  it("keeps interior line feeds", () => {
    expect(dropTrailingLineFeed(Buffer.from("a\r\nb\r\nc\r\n")).toString()).toBe("a\r\nb\r\nc");
  });
});

let counter = 0;

/** Attach like the production client does: the geometry frame goes out
    immediately on open, which is what the seed's width barrier waits for. */
function attach(
  services: Services,
  ws: FakeWS,
  session: Session,
  cols = 80,
  rows = 24,
  scrollback?: number,
): void {
  services.bridge.attach(ws.asWebSocket(), session);
  ws.emitMessage(
    JSON.stringify({ type: "init", cols, rows, ...(scrollback !== undefined ? { scrollback } : {}) }),
  );
}

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
  attach(services, ws, session);

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
  attach(services, ws2, session);
  await waitFor(() => ws2.output().length > 0);
  ws2.emitMessage("echo done\r", true);
  await sleep(300);
  ws2.close();

  await services.sessions.kill(session.id);
});

it("kills only the tmux client on disconnect, not the session", async () => {
  const { services, session } = await createBashSession();
  const ws = new FakeWS();
  attach(services, ws, session);
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
  attach(services, first, session);
  await waitFor(() => first.output().length > 0);

  const second = new FakeWS();
  attach(services, second, session);

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
  attach(services, ws, session);
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
  attach(services, first, session);
  await waitFor(() => first.output().length > 0);
  first.emitMessage("for i in $(seq 1 60); do echo seedline-$i; done\r", true);
  await waitFor(() => first.output().includes("seedline-60"));
  first.close();
  await sleep(300);

  // A fresh attach must receive the history above the current screen as its
  // first binary frames — before anything of the new screen.
  const second = new FakeWS();
  attach(services, second, session);
  await waitFor(() => second.output().includes("seedline-20"));
  const output = second.output();
  expect(output).toContain("seedline-20");
  // Lines must be CRLF-terminated: xterm.js has no ONLCR, so a bare LF from
  // capture-pane would continue each line at the current column (torn layout).
  expect(output).toContain("seedline-20\r\n");
  // The seed-start control frame must precede the seed bytes: it is what
  // makes the client drop its old transcript instead of duplicating it.
  const seedStartAt = second.frames.findIndex(
    (frame) => !frame.binary && frame.data.toString("utf8").includes("seed-start"),
  );
  expect(seedStartAt).toBeGreaterThanOrEqual(0);
  const seedFrame = second.frames.slice(seedStartAt + 1).find((frame) => frame.binary);
  expect(seedFrame?.data.toString("utf8")).toContain("seedline-20");
  // The visible screen arrives as the attach repaint, i.e. after the seed.
  const seedEnd = output.indexOf("seedline-20");
  const repaint = output.indexOf("seedline-60");
  expect(repaint).toBeGreaterThan(seedEnd);

  second.close();
  await services.sessions.kill(session.id);
});

it("seeds only as deep as the client's declared scrollback (D7)", async () => {
  const { services, session } = await createBashSession();

  const first = new FakeWS();
  attach(services, first, session);
  await waitFor(() => first.output().length > 0);
  first.emitMessage("for i in $(seq 1 60); do echo deep-$i; done\r", true);
  await waitFor(() => first.output().includes("deep-60"));
  first.close();
  await sleep(300);

  // A client declaring scrollback: 30 gets the newest ~20 lines above the
  // screen (cap = declared - margin) — not the whole pane history.
  const second = new FakeWS();
  attach(services, second, session, 80, 24, 30);
  await waitFor(() => second.output().includes("deep-25"));
  const output = second.output();
  expect(output).toContain("deep-25");
  expect(output).not.toContain("deep-3\r\n"); // old head excluded by the cap

  second.close();
  await services.sessions.kill(session.id);
});

it("captures the history seed at the client's size, not the spawn size (D7)", async () => {
  const { services, session } = await createBashSession();

  // Produce a line far wider than the 80-column spawn size through a first
  // (80-column) client, so tmux wraps it into the history.
  const first = new FakeWS();
  attach(services, first, session);
  await waitFor(() => first.output().length > 0);
  first.emitMessage(`echo ${"L".repeat(150)}\r`, true);
  await waitFor(() => first.output().includes("L".repeat(80)));
  // Push the wrapped line into history: the seed captures only what sits
  // above the visible screen.
  first.emitMessage("for i in $(seq 1 30); do echo pad-$i; done\r", true);
  await waitFor(() => first.output().includes("pad-30"));
  first.close();
  await sleep(300);

  // Attach at 200 columns: the barrier delays the capture until the
  // client's geometry has been applied and repainted, so the seed renders
  // the long line unwrapped instead of torn at the 80-column spawn size.
  const second = new FakeWS();
  attach(services, second, session, 200, 24);
  await waitFor(() => second.output().includes("L".repeat(150)));
  const seedStartAt = second.frames.findIndex(
    (frame) => !frame.binary && frame.data.toString("utf8").includes("seed-start"),
  );
  const seedFrame = second.frames.slice(seedStartAt + 1).find((frame) => frame.binary);
  expect(seedFrame?.data.toString("utf8")).toContain("L".repeat(150));

  // Web-first sizing: the pane itself must be at the client's geometry, not
  // the 80x24 spawn size — otherwise a plain terminal attached elsewhere
  // would keep the window narrow and the agent output would not fill the
  // browser terminal.
  const width = await execa(
    "tmux",
    [
      "-L",
      services.config.tmuxSocket,
      "display-message",
      "-p",
      "-t",
      session.tmuxName,
      "#{window_width}",
    ],
    { reject: false },
  );
  expect(width.stdout.trim()).toBe("200");

  second.close();
  await services.sessions.kill(session.id);
});

it("expands history on demand when the client scrolls to the top (D7)", async () => {
  const { services, session } = await createBashSession();

  // Produce history through a first client, then leave.
  const first = new FakeWS();
  attach(services, first, session);
  await waitFor(() => first.output().length > 0);
  first.emitMessage("for i in $(seq 1 120); do echo hist-$i; done\r", true);
  await waitFor(() => first.output().includes("hist-120"));
  first.close();
  await sleep(300);

  // A fresh attach with a SHALLOW declared scrollback: the connect-time
  // seed reaches only that deep (scrollback - 10), so the head of the
  // history is not on the wire yet.
  const second = new FakeWS();
  services.bridge.attach(second.asWebSocket(), session);
  second.emitMessage(JSON.stringify({ type: "init", cols: 80, rows: 24, scrollback: 50 }));
  await waitFor(() => second.output().includes("hist-120"));
  const seedStarts = (): string[] => second.text.filter((t) => t.includes("seed-start"));
  expect(seedStarts()).toHaveLength(1);
  expect(seedStarts()[0]).toContain('"lines":40');
  expect(second.output()).not.toContain("hist-1\r\n");

  // The client exhausts its buffer and asks for the full history: a second
  // seed replaces the first and reports the pane exhausted.
  second.emitMessage(JSON.stringify({ type: "history", lines: 49990 }));
  await waitFor(() => seedStarts().length === 2 && second.output().includes("hist-1\r\n"));
  expect(seedStarts()[1]).toContain('"complete":true');
  expect(seedStarts()[1]).not.toContain('"lines":40');

  second.close();
  await services.sessions.kill(session.id);
});

it("does not replay the capture window on top of the snapshot re-seed", async () => {
  const { services, session } = await createBashSession();

  const ws = new FakeWS();
  attach(services, ws, session);
  await waitFor(() => ws.output().length > 0);

  // A pane streaming while the client is up in history: the exact case where
  // a re-seed used to duplicate rows.
  // Paced with gaps: a producer that never holds still is refused by the
  // quiescence guard (correctly — its snapshot would be half-written), so the
  // capture-window property is exercised against a pane that settles between
  // bursts while still producing during the hold.
  ws.emitMessage(
    "i=0; while [ $i -lt 100000 ]; do i=$((i+1)); echo stream-$i; sleep 0.4; done\r",
    true,
  );
  // Paced wider than the settle window: the pane must hold still long enough
  // for the quiescence guard to accept a snapshot at all, or the re-seed is
  // refused and there is no capture window to inspect.
  await waitFor(() => ws.output().includes("stream-2"));

  // Ask for a re-seed while the pane is still producing.
  // The connect-time seed is a seed-skipped when the pane has no history yet
  // (correct: resetting for nothing is worse), so count the delta rather than
  // assuming a fixed total.
  const seedStartsBefore = ws.text.filter((t) => t.includes("seed-start")).length;
  ws.emitMessage(JSON.stringify({ type: "history", lines: 500 }));
  await waitFor(
    () => ws.text.filter((t) => t.includes("seed-start")).length > seedStartsBefore,
  );

  // The seed is a snapshot of the pane at the moment capture-pane read it.
  // Everything the server sends after it must be strictly newer — otherwise
  // the capture window is being replayed on top of a snapshot that already
  // contains it, and the client ends up with that stretch of history twice.
  const seedStarts = ws.frames.filter(
    (frame) => !frame.binary && frame.data.toString("utf8").includes("seed-start"),
  );
  const lastSeedStart = ws.frames.lastIndexOf(seedStarts[seedStarts.length - 1]!);
  const seedFrame = ws.frames.slice(lastSeedStart + 1).find((frame) => frame.binary);
  expect(seedFrame).toBeDefined();

  const numbers = (text: string): number[] =>
    [...text.matchAll(/stream-(\d+)/g)].map((m) => Number(m[1]));
  const inSeed = numbers(seedFrame!.data.toString("utf8"));
  expect(inSeed.length).toBeGreaterThan(0);
  const seedMax = Math.max(...inSeed);

  // The producer must still be running, or there is nothing to compare.
  await waitFor(() =>
    ws.frames
      .slice(ws.frames.indexOf(seedFrame!) + 1)
      .some((frame) => frame.binary && numbers(frame.data.toString("utf8")).some((n) => n > seedMax)),
  );

  const afterSeed = ws.frames
    .slice(ws.frames.indexOf(seedFrame!) + 1)
    .filter((frame) => frame.binary)
    .map((frame) => frame.data.toString("utf8"))
    .join("");
  const after = numbers(afterSeed);
  expect(after.length).toBeGreaterThan(0);
  // THE property: nothing the snapshot already contains may be re-sent. That
  // is the duplication that shows up as repeated and misaligned rows where
  // stable history meets the message being repainted.
  const inSeedSet = new Set(inSeed);
  expect(after.filter((n) => inSeedSet.has(n))).toEqual([]);
  expect(Math.min(...after)).toBeGreaterThan(seedMax);
  // The other side of the same coin: the capture window is excluded from the
  // replay, not dropped. How much is lost is the capture's own duration times
  // the pane's scroll rate — for a repaint-heavy TUI that is ~0 lines, for the
  // tight echo loop here it is tens. Bounded by the requested depth, which is
  // the most one capture could ever cover.
  expect(Math.min(...after) - seedMax).toBeLessThanOrEqual(500);

  ws.close();
  await services.sessions.kill(session.id);
}, 30_000);

it("includes the visible screen in an on-demand re-seed, not just history", async () => {
  const { services, session } = await createBashSession();

  const ws = new FakeWS();
  attach(services, ws, session);
  await waitFor(() => ws.output().length > 0);

  // Push the marker up into history so only a screen-inclusive capture can
  // still see it.
  ws.emitMessage("for i in $(seq 1 60); do echo hist-$i; done; echo SCREEN-MARKER\r", true);
  await waitFor(() => ws.output().includes("SCREEN-MARKER"));
  await sleep(300);

  // The connect-time seed is a seed-skipped when the pane has no history yet
  // (correct: resetting for nothing is worse), so count the delta rather than
  // assuming a fixed total.
  const seedStartsBefore = ws.text.filter((t) => t.includes("seed-start")).length;
  ws.emitMessage(JSON.stringify({ type: "history", lines: 500 }));
  await waitFor(
    () => ws.text.filter((t) => t.includes("seed-start")).length > seedStartsBefore,
  );

  // Live bytes flow while the capture runs (the hold opens only after it), so
  // the seed is the first binary frame after the seed-start, not the first
  // binary frame after the request.
  const seedStarts = ws.frames.filter(
    (frame) => !frame.binary && frame.data.toString("utf8").includes("seed-start"),
  );
  const lastSeedStart = ws.frames.lastIndexOf(seedStarts[seedStarts.length - 1]!);
  const seedFrame = ws.frames.slice(lastSeedStart + 1).find((frame) => frame.binary);
  expect(seedFrame).toBeDefined();
  const seed = seedFrame!.data.toString("utf8");

  // History above the screen...
  expect(seed).toContain("hist-20");
  // ...and the visible screen itself. Without this the client resets to a
  // blank pane and only recovers when the pane next changes.
  expect(seed).toContain("SCREEN-MARKER");

  ws.close();
  await services.sessions.kill(session.id);
});

it("never seeds a screen that is a half-finished repaint", async () => {
  const { services, session } = await createBashSession();

  const ws = new FakeWS();
  attach(services, ws, session);
  await waitFor(() => ws.output().length > 0);

  // A long command sent before the shell is reading gets garbled, and the
  // failure looks like a missing producer. Confirm the shell takes input first.
  ws.emitMessage("echo PROBE-READY\r", true);
  await waitFor(() => ws.output().includes("PROBE-READY"));

  // A streaming agent TUI: each generation is 40 rows bracketed by HEAD and
  // END, drawn slowly (~200ms) and then held (~80ms). The hold is what lets the
  // quiescence guard settle; the long draw is what makes an unguarded capture
  // land mid-repaint. capture-pane is always internally consistent, so "half
  // drawn" is never a torn read — it is a whole snapshot of a pane that really
  // was mid-write, whose last row is a `line NN` instead of END.
  ws.emitMessage(
    "g=0; while [ $g -lt 120 ]; do g=$((g+1)); printf '\\e[H\\e[2J'; " +
      "printf 'gen %04d HEAD\\r\\n' $g; " +
      "for j in $(seq 2 39); do printf 'gen %04d line %02d\\r\\n' $g $j; sleep 0.005; done; " +
      "printf 'gen %04d END\\r\\n' $g; sleep 0.3; done\r",
    true,
  );
  await waitFor(() => ws.binary.length > 100);
  expect(ws.output()).toContain("HEAD");
  // The connect-time seed is history-only (`-E -1`) and lands before the
  // producer starts, so its tail is whatever had just scrolled off — pane
  // truth, not a truncation. Only screen-inclusive re-seeds are under test.
  const seedsFrom = ws.frames.length;

  // Ask several times: a pane that repaints most of the time yields a
  // mid-repaint snapshot on most captures, so one request would be a coin flip
  // and the regression would only show up intermittently.
  for (let i = 0; i < 8; i += 1) {
    ws.emitMessage(JSON.stringify({ type: "history", lines: 300 }));
    await sleep(320);
  }

  // Every seed that came back must be a finished repaint. THE SYMPTOM: before
  // the quiescence guard, at least one of these had a `line NN` as its last
  // row — the reader saw the newest message cut off mid-sentence, completed a
  // moment later when the live stream caught up.
  const seedTexts: string[] = [];
  for (let i = seedsFrom; i < ws.frames.length; i += 1) {
    const frame = ws.frames[i]!;
    if (frame.binary || !frame.data.toString("utf8").includes("seed-start")) continue;
    const seed = ws.frames.slice(i + 1).find((f) => f.binary);
    if (seed) seedTexts.push(seed.data.toString("utf8"));
  }
  // Not vacuous: the pane does settle between generations, so seeds do arrive.
  expect(seedTexts.length).toBeGreaterThan(0);
  for (const text of seedTexts) {
    const rows = text.split("\r\n").filter((r) => r.trim() !== "");
    const screen = rows.slice(-24);
    expect(screen[screen.length - 1]!.trim()).toMatch(/END$/);
  }

  ws.close();
  await services.sessions.kill(session.id);
}, 60_000);

it("delivers arrow keys to alternate-screen apps as ordinary input", async () => {
  const { services, dir, session } = await createBashSession();
  const ws = new FakeWS();
  attach(services, ws, session);
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
