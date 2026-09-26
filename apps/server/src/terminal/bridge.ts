import nodePty from "node-pty";
import { type WebSocket } from "ws";
import type { Session } from "@shellboard/contracts";
import { processEnv } from "../env.js";
import type { ActivityTracker } from "../activity/tracker.js";
import type { TmuxService } from "../tmux/tmux.js";
import { sendControl, wirePtyToSocket } from "./wire.js";

interface AttachedClient {
  ws: WebSocket;
  pty: nodePty.IPty;
  /** Our scroll channel put the pane into tmux copy-mode. */
  copyMode: boolean;
  /** Keystrokes buffered while copy-mode is being cancelled. */
  pendingInput: Buffer[];
  draining: boolean;
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
      },
    );
    const client: AttachedClient = { ws, pty, copyMode: false, pendingInput: [], draining: false };
    this.clients.set(session.id, client);
    this.tracker.setAttached(session.id, true);

    const setCopyMode = (active: boolean): void => {
      if (client.copyMode === active) return;
      client.copyMode = active;
      sendControl(ws, { type: "copy-mode", active });
    };

    /**
     * Keystrokes while in copy-mode would be eaten by it (search keys, not
     * the shell). VS Code semantics instead: any input returns to the live
     * view — cancel copy-mode first, then forward the buffered bytes.
     */
    const pumpInput = (): void => {
      if (client.draining) return;
      client.draining = true;
      void (async () => {
        for (;;) {
          if (client.pendingInput.length === 0) {
            client.draining = false;
            return;
          }
          if (client.copyMode) {
            await this.tmux.cancelCopyMode(session.tmuxName);
            setCopyMode(false);
          }
          for (const chunk of client.pendingInput.splice(0)) {
            pty.write(chunk);
          }
        }
      })();
    };

    const handleInput = (data: Buffer): void => {
      if (!client.copyMode) {
        pty.write(data);
        return;
      }
      client.pendingInput.push(data);
      pumpInput();
    };

    let ended = false;
    wirePtyToSocket(
      ws,
      pty,
      () => {
        ended = true;
        if (this.clients.get(session.id) === client) {
          this.clients.delete(session.id);
          this.tracker.setAttached(session.id, false);
        }
      },
      {
        onScroll: (lines) => {
          if (lines > 0) setCopyMode(true);
          this.tmux.scroll(session.tmuxName, lines);
        },
        onInput: handleInput,
        onBottom: () => {
          if (!client.copyMode) return;
          client.pendingInput.push(Buffer.alloc(0)); // flush sentinel
          pumpInput();
        },
      },
    );

    // A previous client may have left the pane in copy-mode; sync the new
    // socket's history-mode state with reality.
    void this.tmux
      .isInCopyMode(session.tmuxName)
      .then((active) => setCopyMode(active))
      .catch(() => {});
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
