import nodePty from "node-pty";
import { type WebSocket } from "ws";
import { execa } from "execa";
import type { Session } from "@shellboard/contracts";
import { processEnv } from "../env.js";
import type { ActivityTracker } from "../activity/tracker.js";
import { sendControl, wirePtyToSocket } from "./wire.js";

interface AttachedClient {
  ws: WebSocket;
  pty: nodePty.IPty;
}

/** Seed size cap: the web client's default scrollback is 5000 lines, so
    fetching more is wasted WAN bytes (the head is discarded on render). */
const SEED_MAX_LINES = 4990;
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
  private readonly clients = new Map<string, AttachedClient>();

  constructor(socket: string, tracker: ActivityTracker) {
    this.socket = socket;
    this.tracker = tracker;
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
      },
    );
    const client: AttachedClient = { ws, pty };
    this.clients.set(session.id, client);
    this.tracker.setAttached(session.id, true);

    wirePtyToSocket(ws, pty, () => {
      if (this.clients.get(session.id) === client) {
        this.clients.delete(session.id);
        this.tracker.setAttached(session.id, false);
      }
    }, { holdOutputUntil: this.seedFor(pty, session.tmuxName) });

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
      }
    });
  }

  /** Connect-time history seed (D7). tmux's attach protocol only ever sends
      the current screen, so a freshly opened page would have nothing to
      scroll. capture-pane renders the pane's own history as a linear escape
      document at the pane's current width; those bytes are forwarded
      verbatim to the connecting client and used for nothing else — no
      parsing, no logging, no persistence. The capture is gated on the first
      attach repaint: that proves tmux processed the attach and the pane has
      settled at this client's size, so the seed matches the client width. */
  private seedFor(pty: nodePty.IPty, tmuxName: string): Promise<Buffer | null> {
    const firstOutput = new Promise<null>((resolve) => {
      const guard = setTimeout(() => resolve(null), FIRST_OUTPUT_TIMEOUT_MS);
      const off = pty.onData(() => {
        clearTimeout(guard);
        off.dispose();
        resolve(null);
      });
    });
    return firstOutput.then(() =>
      execa(
        "tmux",
        [
          "-L",
          this.socket,
          "capture-pane",
          "-p",
          "-e",
          "-T",
          "-S",
          `-${SEED_MAX_LINES}`,
          "-E",
          "-1",
          "-t",
          tmuxName,
        ],
        { encoding: "buffer", reject: false, timeout: FIRST_OUTPUT_TIMEOUT_MS },
      ).then((r) =>
        // execa 10 binary output is a plain Uint8Array, not a Buffer
        r.stdout instanceof Uint8Array && r.stdout.length > 0
          ? normalizeSeedLineEndings(r.stdout)
          : null,
      ).catch(() => null),
    );
  }
}
