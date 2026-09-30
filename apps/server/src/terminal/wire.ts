import type nodePty from "node-pty";
import { WebSocket } from "ws";

export type ClientControlMessage =
  | { type: "init"; cols?: number; rows?: number; scrollback?: number }
  | { type: "resize"; cols?: number; rows?: number }
  | { type: "history"; lines?: number }
  | { type: "ping" };

export type ServerControlMessage =
  | { type: "taken-over" }
  | { type: "seed-start"; lines: number; complete: boolean }
  | { type: "seed-skipped" }
  | { type: "ended" }
  | { type: "pong" };

/** Connect-time (and on-demand) history seed. `lines` is how many lines the
    seed carries; `complete` says the pane has nothing deeper — the client
    can stop asking. */
export interface SeedPayload {
  seed: Buffer | null;
  lines: number;
  complete: boolean;
}

/** Deepest history a client may ask for: aligned with the tmux-side
    history-limit so a request can never exceed what tmux retains. */
export const MAX_SEED_LINES = 49990;
/** Default connect-time depth when the client does not declare one. */
export const DEFAULT_SEED_LINES = 4990;

export function parseControlMessage(data: Buffer): ClientControlMessage | null {
  try {
    const parsed = JSON.parse(data.toString("utf8")) as Partial<ClientControlMessage>;
    if (
      parsed.type === "init" ||
      parsed.type === "resize" ||
      parsed.type === "history" ||
      parsed.type === "ping"
    ) {
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

/** History depth clamp for init/history frames. */
export function clampSeedLines(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 10), MAX_SEED_LINES);
}

/** Handle returned by wirePtyToSocket for re-seeding at a deeper history
    depth (on-demand scrollback expansion). */
export interface WireHandle {
  reseed(payload: Promise<SeedPayload>): void;
}

export interface WireOptions {
  /** Receives binary keystrokes; defaults to writing straight to the PTY. */
  onInput?: (data: Buffer) => void;
  /** Resolves with the connect-time history seed. PTY output is buffered
      until it resolves, the seed is sent first, then the buffered live
      bytes — wire order stays: old content, then new. */
  holdOutputUntil?: Promise<SeedPayload>;
  /** Called after a resize control frame has been applied to the PTY,
      with the geometry the client asked for. */
  onResize?: (cols: number, rows: number) => void;
  /** Called when the client announces its geometry and buffer size. The
      scrollback value is how deep the connect-time history seed should
      reach — it must match the client's buffer or the head is discarded. */
  onInit?: (message: Extract<ClientControlMessage, { type: "init" }>) => void;
  /** Called when the client asks for a deeper history seed (it scrolled to
      the top of its buffer). Re-run the capture and hand the payload to the
      returned handle's reseed(). */
  onHistory?: (lines: number) => void;
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
): WireHandle {
  const writeInput = options.onInput ?? ((data: Buffer) => pty.write(data));
  let hold = false;
  let held: Buffer[] = [];
  let heldBytes = 0;
  let paused = false;

  /** Open the hold: live bytes accumulate instead of reaching the client. */
  const openHold = (): void => {
    held = [];
    heldBytes = 0;
    hold = true;
  };

  /** Close the hold. The seed goes first — the client clears its buffer on
      seed-start, so the seed must arrive before anything that follows it —
      then everything that accumulated while the hold was open, in wire order.
      A hold that grew past HELD_MAX_BYTES sacrifices the seed instead: the
      live stream must stay intact, and the seed must not cost unbounded
      memory on a firehose pane. */
  const closeHold = (payload: SeedPayload): void => {
    hold = false;
    const buffered = held;
    const bufferedBytes = heldBytes;
    held = [];
    heldBytes = 0;
    if (ws.readyState !== WebSocket.OPEN) return;
    const sendSeed = bufferedBytes <= HELD_MAX_BYTES;
    if (sendSeed) {
      sendControl(ws, { type: "seed-start", lines: payload.lines, complete: payload.complete });
    } else {
      // The existing client buffer remains valid. Tell it not to reset or
      // mistake the first held live frame for the omitted seed.
      sendControl(ws, { type: "seed-skipped" });
    }
    if (sendSeed && payload.seed !== null && payload.seed.length > 0) {
      ws.send(payload.seed, { binary: true });
    }
    for (const chunk of buffered) {
      ws.send(chunk, { binary: true });
    }
  };

  const startHold = (payload: Promise<SeedPayload>): void => {
    openHold();
    void payload.then(closeHold, () =>
      // A failed capture must not leave the hold open forever — that would
      // silently stop all output to this client.
      closeHold({ seed: null, lines: 0, complete: true }),
    );
  };
  if (options.holdOutputUntil) startHold(options.holdOutputUntil);
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  const checkDrain = (): void => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > WS_LOW_WATER) return;
    if (drainTimer !== null) clearInterval(drainTimer);
    drainTimer = null;
    paused = false;
    pty.resume();
  };
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
      // A paused PTY emits no onData event, so it cannot resume from this
      // callback. Observe the socket queue until it drains instead.
      drainTimer = setInterval(checkDrain, 50);
    }
  });
  pty.onExit(() => {
    if (drainTimer !== null) clearInterval(drainTimer);
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
      const cols = clampSize(message.cols, 80);
      const rows = clampSize(message.rows, 24);
      try {
        pty.resize(cols, rows);
      } catch {
        // pane/session may be gone; tmux resizes on next attach
      }
      options.onResize?.(cols, rows);
      if (message.type === "init") options.onInit?.(message);
    } else if (message.type === "history") {
      options.onHistory?.(clampSeedLines(message.lines, DEFAULT_SEED_LINES));
    } else if (message.type === "ping") {
      sendControl(ws, { type: "pong" });
    }
  });
  ws.on("close", () => {
    if (drainTimer !== null) clearInterval(drainTimer);
    try {
      pty.kill();
    } catch {
      // already gone
    }
    onEnd();
  });

  return {
    // Re-hold the stream and re-seed at a deeper depth. The live stream
    // keeps buffering while the capture runs, then resumes after the seed —
    // the same machinery as the connect-time hold, re-armed on demand.
    //
    // Ordering is the whole point: the caller must have finished the capture
    // BEFORE calling this. Holding first and capturing after would buffer a
    // window of live output that the snapshot already contains, and flushing
    // it after the seed replays that window on top — duplicating the stretch
    // of history it produced. On a streaming pane that lands exactly where
    // stable history meets the message being repainted, which reads as
    // duplicated and misaligned rows at the seam. Pausing the PTY does not
    // help either: it stops node-pty reading the pty, not the pane being
    // written, so the snapshot ends up newer than the bytes being held and
    // the overlap grows.
    reseed: (payload: Promise<SeedPayload>): void => startHold(payload),
  };
}
