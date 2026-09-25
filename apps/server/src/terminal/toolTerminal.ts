import nodePty from "node-pty";
import { WebSocket } from "ws";
import { defaultShell, processEnv } from "../env.js";
import { wirePtyToSocket } from "./wire.js";

/**
 * Ephemeral secondary shell: node-pty → bash directly (no tmux). Dies with
 * the browser connection by design.
 */
export class ToolTerminalManager {
  handle(ws: WebSocket, cwd: string): void {
    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(defaultShell(), [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: processEnv(),
      });
    } catch {
      ws.close(1011, "cannot spawn shell");
      return;
    }
    wirePtyToSocket(ws, pty, () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "shell exited");
      }
    });
  }
}
