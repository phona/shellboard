import type nodePty from "node-pty";
import { WebSocket } from "ws";

export type ClientControlMessage =
  | { type: "init"; cols?: number; rows?: number; scrollback?: number }
  | { type: "resize"; cols?: number; rows?: number }
  | { type: "ping" };

export type ServerControlMessage =
  | { type: "taken-over" }
  | { type: "seed-start" }
  | { type: "ended" }
  | { type: "pong" };

export function parseControlMessage(data: Buffer): ClientControlMessage | null {
  try {
    const parsed = JSON.parse(data.toString("utf8")) as Partial<ClientControlMessage>;
    if (parsed.type === "init" || parsed.type === "resize" || parsed.type === "ping") {
      return parsed as ClientControlMessage;
    }
    return null;
  } catch {
    return null;
  }
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
  /** Receives binary keystrokes; defaults to writing straight to the PTY. */
  onInput?: (data: Buffer) => void;
  /** Resolves with an optional seed payload (connect-time history). PTY
      output is buffered until it resolves, the seed is sent first, then the
      buffered live bytes — wire order stays: old content, then new. */
  holdOutputUntil?: Promise<Buffer | null>;
  /** Called after a resize control frame has been applied to the PTY. */
  onResize?: () => void;
  /** Called when the client announces its geometry and buffer size. The
      scrollback value is how deep the connect-time history seed should
      reach — it must match the client's buffer or the head is discarded. */
  onInit?: (message: Extract<ClientControlMessage, { type: "init" }>) => void;
}

/** Pause the PTY when the socket's send queue passes this many bytes. */
const WS_HIGH_WATER = 4 * 1024 * 1024;
/** Resume once it drains back below this. */
const WS_LOW_WATER = 1 * 1024 * 1024;
/** Live bytes buffered during the seed hold past which the seed (history)
    is sacrificed: the live stream must stay intact, and the seed must not
    cost unbounded memory on a firehose pane. */
const HELD_MAX_BYTES = 8 * 1024 * 1024;

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
  let hold = options.holdOutputUntil !== undefined;
  let held: Buffer[] = [];
  let heldBytes = 0;
  if (hold) {
    void options.holdOutputUntil!.then((seed) => {
      hold = false;
      if (ws.readyState !== WebSocket.OPEN) {
        held = [];
        return;
      }
      // The seed replaces whatever the client had: every attach (including
      // a reconnect) re-seeds from tmux, and appending it to a surviving
      // buffer would duplicate the whole transcript. The client clears
      // its buffer on this frame; the seed bytes then repaint the history.
      sendControl(ws, { type: "seed-start" });
      if (seed !== null && seed.length > 0 && heldBytes <= HELD_MAX_BYTES) {
        ws.send(seed, { binary: true });
      }
      for (const chunk of held) {
        ws.send(chunk, { binary: true });
      }
      held = [];
    });
  }
  let paused = false;
  pty.onData((data) => {
    if (hold) {
      held.push(Buffer.from(data));
      heldBytes += data.length;
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, { binary: true });
    }
    // Backpressure: a client that stops draining (mobile link, slept
    // laptop, TCP zero window) must not grow the server's send queue — or
    // tmux's client-side queue behind it — without bound. Pause the PTY
    // above the high mark, resume once the socket drains.
    if (!paused && ws.bufferedAmount > WS_HIGH_WATER) {
      paused = true;
      pty.pause();
    } else if (paused && ws.bufferedAmount < WS_LOW_WATER) {
      paused = false;
      pty.resume();
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
        options.onResize?.();
      } catch {
        // pane/session may be gone; tmux resizes on next attach
      }
      if (message.type === "init") options.onInit?.(message);
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
