import nodePty from "node-pty";
import { type WebSocket } from "ws";
import type { Session } from "@shellboard/contracts";
import { processEnv } from "../env.js";
import type { ActivityTracker } from "../activity/tracker.js";
import { sendControl, wirePtyToSocket } from "./wire.js";

interface AttachedClient {
  ws: WebSocket;
  pty: nodePty.IPty;
}

/**
 * One PTY per session (D4). A second client takes over: the old PTY is
 * killed, the old socket is closed with 4001. The tmux session itself is
 * never touched from here (D5) — killing the `tmux attach` client process
 * leaves the agent running.
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

    let ended = false;
    wirePtyToSocket(ws, pty, () => {
      ended = true;
      if (this.clients.get(session.id) === client) {
        this.clients.delete(session.id);
        this.tracker.setAttached(session.id, false);
      }
    });
    ws.on("close", () => {
      // If the socket dropped without the PTY exiting, clean up here.
      if (!ended && this.clients.get(session.id) === client) {
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
}
