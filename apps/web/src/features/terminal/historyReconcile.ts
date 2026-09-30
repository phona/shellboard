/** Deepest history the client will hold/pull — aligned with the server's
    clamp and the tmux history-limit, so a request can never exceed what
    tmux retains. */
export const MAX_HISTORY_LINES = 49990;

/** Scroll-triggered transcript reconcile (D7 "校准机制"). Reading history
    can drift from the pane — a redraw-heavy TUI (agent CLI) repaints each
    message in full, and tmux forwards every repaint, so a byte-accumulated
    client scrollback holds every intermediate state. The pane's own history
    stays clean (capture-pane gives one line per row), so the client buffer
    is a *cache* of pane truth and has to be re-pulled to be trusted.

    This module owns only the guards. The hook owns the mutable state (last
    reconcile time, slow-link flag, output-since-reconcile, whether the user
    has scrolled since the last re-seed); everything the decision needs is
    passed in as plain data so it is testable off one clock. */

/** Shallow depth for the reconcile re-pull. Only the stretch the user is
    actually reading has to be realigned, and a shallow capture keeps the
    re-seed — which clears the client buffer before repainting — cheap
    enough to run while a pane is streaming. The trade is deliberate:
    deeper history is dropped by a reconcile and grown back on demand by
    the scroll-to-top path, which is the user's own explicit request. */
export const RECONCILE_DEPTH = 500;

/** Scroll must settle for this long before a reconcile may fire. A user
    still scrolling must never have the buffer swapped underneath them —
    the gesture is a read, not a refresh request, until it stops. */
export const RECONCILE_SETTLE_MS = 1500;

/** Backstop cooldown between automatic reconciles. The gesture requirement
    already bounds this to one per scroll-stop; the cooldown only stops a
    stop-scroll-stop cycle from strobing the buffer. */
export const RECONCILE_MIN_INTERVAL_MS = 5000;

/** A re-push slower than this marks the link slow: reconciles then back
    off to a longer cooldown, so a weak connection is not spent re-rendering
    history the user is still reading. Sticky for the session — flapping it
    would make the terminal's behavior unpredictable. */
export const SLOW_LINK_MS = 1000;
export const SLOW_LINK_RECONCILE_INTERVAL_MS = 15_000;

/** A reconcile only fires once the viewport sits at least this many lines
    above the live bottom. Coming back to live must never cost a request —
    the live view is the pane's current screen and is already exact. */
export const RECONCILE_MIN_OFF_BOTTOM = 8;

/** Everything the scroll-triggered reconcile decision needs, as plain data. */
export interface ReconcileInput {
  /** The connect-time history seed has landed. */
  seeded: boolean;
  /** A deeper re-seed (scroll-to-top growth or another reconcile) is in
      flight; the live stream is held, so do not pile another request on. */
  expanding: boolean;
  /** New output arrived since the last re-seed — drift only comes from new
      output, so a quiet history must not re-pull the same bytes. */
  outputSinceReconcile: boolean;
  /** The user has scrolled since the last re-seed. Without this a single
      reconcile would re-arm itself forever on a streaming pane: every
      re-seed leaves stale content again as soon as the next repaint lands,
      and the terminal would strobe between two buffers once per cooldown.
      One clean-up per deliberate scroll-stop is the contract. */
  gesturedSinceReseed: boolean;
  /** xterm buffer geometry: where the viewport sits vs. the live bottom. */
  viewportY: number;
  baseY: number;
  /** When the last re-seed went out (epoch ms). */
  lastReconcileAt: number;
  /** Current time (epoch ms) — passed in, not read, so the decision is
      testable and uses one clock per call. */
  now: number;
  /** The WebSocket is open and can carry the request. */
  wsOpen: boolean;
  /** The link has proven too slow for a full re-render; reconciles back off. */
  slowLink: boolean;
  /** Depth to re-pull at — shallow, so the buffer clear stays cheap. */
  reconcileDepth: number;
}

/** Decide whether a settled scroll should trigger a transcript re-pull, and
    at what depth. Returns null when any guard says no — the guards are
    ordered cheapest-first and must stay in sync with the hook's semantics:
    never reconcile before the seed lands, while a re-seed is in flight,
    without new output to realign, without a scroll to ask for it, near the
    live bottom, inside the cooldown, or with the socket down. */
export function decideReconcile(input: ReconcileInput): { depth: number } | null {
  const {
    seeded,
    expanding,
    outputSinceReconcile,
    gesturedSinceReseed,
    viewportY,
    baseY,
    lastReconcileAt,
    now,
    wsOpen,
    slowLink,
    reconcileDepth,
  } = input;
  if (!seeded || expanding) return null;
  if (!outputSinceReconcile) return null; // nothing new to realign
  if (!gesturedSinceReseed) return null; // one clean-up per scroll-stop
  if (viewportY > baseY - RECONCILE_MIN_OFF_BOTTOM) return null;
  const cooldown = slowLink ? SLOW_LINK_RECONCILE_INTERVAL_MS : RECONCILE_MIN_INTERVAL_MS;
  if (now - lastReconcileAt < cooldown) return null;
  if (!wsOpen) return null;
  return { depth: reconcileDepth };
}

/** How the held history depth reacts to a seed-start payload. The server
    reports what it actually sent: fewer lines than requested (or an explicit
    complete) means the pane has nothing deeper — mark the ceiling reached so
    scroll-to-top stops asking. Comparing against the *requested* depth (not
    the held one) keeps a shallow reconcile from reading as "exhausted" and
    killing the scroll-to-top growth. */
export function nextHistoryDepthAfterSeedStart(
  serverLines: number | undefined,
  complete: boolean | undefined,
  requestedDepth: number,
  currentDepth: number,
): number {
  if (complete === true) return MAX_HISTORY_LINES;
  if (typeof serverLines === "number" && serverLines > 0 && serverLines < requestedDepth) {
    return MAX_HISTORY_LINES;
  }
  return currentDepth;
}

/** Whether the re-push in flight counts as a slow transfer: seed-start
    arrival to the seed frame's write callback, against the slow-link
    threshold. */
export function isSlowTransfer(seedStartedAt: number, now: number): boolean {
  return now - seedStartedAt > SLOW_LINK_MS;
}
