import type nodePty from "node-pty";
import { WebSocket } from "ws";

export type ClientControlMessage =
  | { type: "init"; cols?: number; rows?: number }
  | { type: "resize"; cols?: number; rows?: number }
  | { type: "scroll"; lines?: number }
  | { type: "scroll-bottom" }
  | { type: "ping" };

export type ServerControlMessage =
  | { type: "taken-over" }
  | { type: "ended" }
  | { type: "pong" }
  | { type: "copy-mode"; active: boolean };

export function parseControlMessage(data: Buffer): ClientControlMessage | null {
  try {
    const parsed = JSON.parse(data.toString("utf8")) as Partial<ClientControlMessage>;
    if (
      parsed.type === "init" ||
      parsed.type === "resize" ||
      parsed.type === "scroll" ||
      parsed.type === "scroll-bottom" ||
      parsed.type === "ping"
    ) {
      return parsed as ClientControlMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export function clampLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded > 60) return 60;
  if (rounded < -60) return -60;
  return rounded;
}

export function sendControl(ws: WebSocket, message: ServerControlMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function clampSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 2), 500);
}

export interface WireOptions {
  onScroll?: (lines: number) => void;
  /** Receives binary keystrokes; defaults to writing straight to the PTY. */
  onInput?: (data: Buffer) => void;
  /** "Jump to bottom": exit copy-mode if active. */
  onBottom?: () => void;
}

/**
 * Wires one PTY to one socket: binary frames are terminal bytes (opaque),
 * text frames are control messages. Kills the PTY when the socket closes.
 */
export function wirePtyToSocket(
  ws: WebSocket,
  pty: nodePty.IPty,
  onEnd: () => void,
  options: WireOptions = {},
): void {
  const writeInput = options.onInput ?? ((data: Buffer) => pty.write(data));
  pty.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, { binary: true });
    }
  });
  pty.onExit(() => {
    sendControl(ws, { type: "ended" });
    onEnd();
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      writeInput(data);
      return;
    }
    const message = parseControlMessage(data);
    if (!message) return;
    if (message.type === "init" || message.type === "resize") {
      try {
        pty.resize(clampSize(message.cols, 80), clampSize(message.rows, 24));
      } catch {
        // pane/session may be gone; tmux resizes on next attach
      }
    } else if (message.type === "scroll") {
      const lines = clampLines(message.lines);
      if (lines !== 0) options.onScroll?.(lines);
    } else if (message.type === "scroll-bottom") {
      options.onBottom?.();
    } else if (message.type === "ping") {
      sendControl(ws, { type: "pong" });
    }
  });
  ws.on("close", () => {
    try {
      pty.kill();
    } catch {
      // already gone
    }
    onEnd();
  });
}
