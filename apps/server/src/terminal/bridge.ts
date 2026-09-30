import nodePty from "node-pty";
import { type WebSocket } from "ws";
import { execa } from "execa";
import type { Session } from "@shellboard/contracts";
import { processEnv } from "../env.js";
import type { ActivityTracker } from "../activity/tracker.js";
import type { TmuxService } from "../tmux/tmux.js";
import { sendControl, wirePtyToSocket } from "./wire.js";
import {
  clampSeedLines,
  DEFAULT_SEED_LINES,
  type SeedPayload,
} from "./wire.js";

interface AttachedClient {
  ws: WebSocket;
  pty: nodePty.IPty;
}

/** The attach repaint normally lands in well under a second; past this the
    session is presumed dead and we seed without the width-matched barrier. */
const FIRST_OUTPUT_TIMEOUT_MS = 3000;

/** capture-pane separates lines with bare LF (a real terminal's ONLCR turns
    that into CRLF; xterm.js has no such translation — a bare LF moves down
    without returning the cursor to column 0, tearing every seeded line into
    fragments at arbitrary columns). Raw 0x0a never occurs inside escape
    sequences, so the byte-level rewrite is safe. */
function normalizeSeedLineEndings(seed: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < seed.length; i++) {
    if (seed[i] === 0x0a && (i === 0 || seed[i - 1] !== 0x0d)) {
      parts.push(Buffer.from(seed.subarray(start, i)), Buffer.from("\r\n"));
      start = i + 1;
    }
  }
  parts.push(Buffer.from(seed.subarray(start)));
  return Buffer.concat(parts);
}

/** capture-pane ends its output with a line feed, and the CRLF rewrite turns
    that into a scroll: a screen-inclusive seed would shift the repainted
    screen up by one row and leave the client misaligned with the pane. That
    off-by-one is what starts the drift cascade — every later relative repaint
    then lands one row off — so it is dropped here. */
function dropTrailingLineFeed(seed: Buffer): Buffer {
  let end = seed.length;
  if (end > 0 && seed[end - 1] === 0x0a) end -= 1;
  if (end > 0 && seed[end - 1] === 0x0d) end -= 1;
  return end === seed.length ? seed : seed.subarray(0, end);
}

/**
 * One PTY per session (D4). A second client takes over: the old PTY is
 * killed, the old socket is closed with 4001. The tmux session itself is
 * never touched from here (D5) — killing the `tmux attach` client process
 * leaves the agent running.
 *
 * Output is the tmux attach stream, forwarded opaquely: the client renders
 * it into its own buffer (tmux runs with smcup/rmcup/indn removed — see
 * tmux.ts — so pane scrolling reaches the client as LF scrolling and the
 * transcript accumulates in local scrollback, D7).
 */
export class TerminalBridge {
  private readonly socket: string;
  private readonly tracker: ActivityTracker;
  private readonly tmux: TmuxService;
  private readonly clients = new Map<string, AttachedClient>();

  constructor(socket: string, tracker: ActivityTracker, tmux: TmuxService) {
    this.socket = socket;
    this.tracker = tracker;
    this.tmux = tmux;
  }

  attach(ws: WebSocket, session: Session): void {
    const existing = this.clients.get(session.id);
    if (existing) {
      this.clients.delete(session.id);
      sendControl(existing.ws, { type: "taken-over" });
      try {
        existing.pty.kill();
      } catch {
        // already gone
      }
      existing.ws.close(4001, "taken over");
    }

    const pty = nodePty.spawn(
      "tmux",
      ["-L", this.socket, "attach-session", "-t", session.tmuxName],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: session.cwd,
        env: processEnv(),
        // Terminal bytes are opaque (architecture red line): without this,
        // node-pty decodes the pty stream as UTF-8 and every invalid byte
        // (binary output, latin-1 logs) is silently rewritten to U+FFFD
        // before it reaches the client.
        encoding: null,
      },
    );
    const client: AttachedClient = { ws, pty };
    this.clients.set(session.id, client);
    this.tracker.setAttached(session.id, true);

    // The seed's width barrier: the capture must happen after the client's
    // first init/resize has been applied — to the PTY *and* to the window
    // (web-first sizing) — so tmux renders the history at the client's size
    // rather than the 80x24 spawn size.
    let signalResize: () => void = () => {};
    const firstResize = new Promise<void>((resolve) => {
      signalResize = resolve;
    });
    // Seed depth follows the client's declared scrollback (D7): the value
    // arrives with the same init frame as the geometry, before the capture.
    // On-demand expansions (the client scrolled to the top of its buffer)
    // rewrite it and re-seed deeper — tmux keeps up to MAX_SEED_LINES.
    const seedDepth = { lines: DEFAULT_SEED_LINES };

    // Web-first sizing (window-size manual): the browser's geometry is the
    // only thing that sizes the pane. The barrier opens after the window
    // has actually been resized, so the seed that follows renders at the
    // client's width.
    const applyClientGeometry = (cols: number, rows: number): void => {
      void (async () => {
        try {
          await this.tmux.resizeWindow(session.tmuxName, cols, rows);
        } catch {
          // window gone / tmux hiccup: the barrier must still open; the
          // seed then renders at whatever size the pane kept
        } finally {
          signalResize();
        }
      })();
    };

    const wire = wirePtyToSocket(ws, pty, () => {
      if (this.clients.get(session.id) === client) {
        this.clients.delete(session.id);
        this.tracker.setAttached(session.id, false);
      }
    }, {
      onResize: applyClientGeometry,
      onInit: (message) => {
        if (
          typeof message.scrollback === "number" &&
          Number.isFinite(message.scrollback)
        ) {
          seedDepth.lines = clampSeedLines(message.scrollback - 10, DEFAULT_SEED_LINES);
        }
      },
      onHistory: (lines) => {
        // The client exhausted its local buffer: re-seed deeper. The window
        // is already at the client's size, so the width barrier is a no-op.
        seedDepth.lines = lines;
        // Capture FIRST, hold AFTER. The seed is then a snapshot of the pane
        // and every byte that follows it is strictly newer, so flushing the
        // held bytes on top cannot duplicate the window the capture took.
        // (Holding first would buffer that window and replay it after the
        // seed — the seam artifact this ordering exists to avoid.)
        void this.seedFor(pty, session.tmuxName, Promise.resolve(), () => seedDepth.lines, true).then(
          (payload) => wire.reseed(Promise.resolve(payload)),
        );
      },
      holdOutputUntil: this.seedFor(pty, session.tmuxName, firstResize, () => seedDepth.lines),
    });

    ws.on("close", () => {
      // If the socket dropped without the PTY exiting, clean up here.
      if (this.clients.get(session.id) === client) {
        try {
          pty.kill();
        } catch {
          // already gone
        }
        this.clients.delete(session.id);
        this.tracker.setAttached(session.id, false);
        // Last web client gone: the pane is pinned to this browser's
        // geometry — hand the size back to whatever client remains so a
        // plain terminal is not left viewing a cropped window.
        void this.tmux.restoreWindowSize(session.tmuxName);
      }
    });
  }

  /** Connect-time history seed (D7), also re-run on demand for deeper
      scrollback. tmux's attach protocol only ever sends the current screen,
      so a freshly opened page would have nothing to scroll. capture-pane
      renders the pane's own history as a linear escape document at the
      pane's current width; those bytes are forwarded verbatim to the
      connecting client and used for nothing else — no parsing, no logging,
      no persistence. The capture is gated on `barrier` (the client's first
      init/resize and the repaint it forces) so the seed renders at the
      client's width; a socket that never resizes falls back to a timed
      capture at the spawn size. On-demand re-seeds pass an already-resolved
      barrier — the window is already at the client's size.

      `includeScreen` captures the visible screen as well as the history above
      it. Only correct when the caller takes the snapshot BEFORE opening the
      hold (see `onHistory`): the seed then stands alone as the pane's state,
      and every byte replayed after it is strictly newer, so nothing is
      painted twice. The connect-time seed must stay history-only — it has to
      wait for the resize repaint, so the attach repaint that follows supplies
      the screen, and including it would repaint that screen a second time. */
  private seedFor(
    pty: nodePty.IPty,
    tmuxName: string,
    barrier: Promise<void>,
    seedLines: () => number,
    includeScreen = false,
  ): Promise<SeedPayload> {
    const settled = Promise.race([
      barrier.then(() => nextOutput(pty)),
      delay(FIRST_OUTPUT_TIMEOUT_MS),
    ]);
    return settled
      .then(() =>
        execa(
          "tmux",
          [
            "-L",
            this.socket,
            "display-message",
            "-p",
            "-t",
            tmuxName,
            "#{history_size}",
          ],
          { reject: false, timeout: FIRST_OUTPUT_TIMEOUT_MS },
        ),
      )
      .then((probe) => {
        // Read the depth HERE, not at call time: the client's declared
        // scrollback arrives with its init frame, which lands while the
        // barrier is still open.
        const requested = seedLines();
        // No history above the screen: `-E -1` would clamp to line 0 and
        // return the first VISIBLE line, which the attach repaint then
        // sends again — a duplicated line at the seam on every fresh
        // session. Skip the seed instead. A screen-inclusive capture is
        // still worth taking with no history: it repaints the pane the user
        // is looking at, which is the whole point of the re-seed.
        const historySize = probe.failed ? 0 : Number(probe.stdout.trim());
        if (!includeScreen && (!Number.isFinite(historySize) || historySize === 0)) {
          return { seed: null, lines: 0, complete: true };
        }
        const capture = [
          "-L",
          this.socket,
          "capture-pane",
          "-p",
          "-e",
          "-T",
          "-S",
          `-${requested}`,
        ];
        // History-only for the connect-time seed: `-E -1` stops just above
        // the visible screen so the attach repaint that follows lands
        // seamlessly on top.
        if (!includeScreen) capture.push("-E", "-1");
        capture.push("-t", tmuxName);
        return execa("tmux", capture, {
          encoding: "buffer",
          reject: false,
          timeout: FIRST_OUTPUT_TIMEOUT_MS,
        }).then((r) =>
          // execa 10 binary output is a plain Uint8Array, not a Buffer
          r.stdout instanceof Uint8Array && r.stdout.length > 0
            ? {
                seed: includeScreen
                  ? dropTrailingLineFeed(normalizeSeedLineEndings(r.stdout))
                  : normalizeSeedLineEndings(r.stdout),
                // capture-pane returns at most `requested` lines
                lines: Math.min(requested, Math.max(historySize, 0)),
                // fewer lines than asked = the pane's history is exhausted
                complete: historySize <= requested,
              }
            : { seed: null, lines: 0, complete: true },
        );
      })
      .catch(() => ({ seed: null, lines: 0, complete: true }));
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves on the next PTY data frame (tmux's repaint after a resize),
    or after `ms` if the pane stays quiet. */
function nextOutput(pty: nodePty.IPty, ms = FIRST_OUTPUT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const guard = setTimeout(resolve, ms);
    const off = pty.onData(() => {
      clearTimeout(guard);
      off.dispose();
      resolve();
    });
  });
}
