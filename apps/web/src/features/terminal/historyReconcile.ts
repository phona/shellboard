/** Deepest history the client will hold/pull — aligned with the server's
    clamp and the tmux history-limit, so a request can never exceed what
    tmux retains. */
export const MAX_HISTORY_LINES = 49990;

/** Scroll-triggered transcript reconcile. Reading history can drift from the
    pane (reflow, partial lines), so while the user is up in history the
    client re-pulls at the depth it already holds to clean up the stretch on
    screen. At most one per this interval, and only once the viewport sits at
    least this many lines above the live bottom — coming back to live must
    never cost a request. */
export const RECONCILE_MIN_INTERVAL_MS = 5000;
export const RECONCILE_MIN_OFF_BOTTOM = 8;

/** A re-push slower than this marks the link slow: reconciles then ask for a
    shallow depth instead of the full one, so refreshing what is on screen
    stays cheap on a weak connection. Sticky for the session — flapping it
    would make the terminal's behavior unpredictable. */
export const SLOW_LINK_MS = 1000;
export const SLOW_LINK_RECONCILE_DEPTH = 1000;

/** Everything the scroll-triggered reconcile decision needs, as plain data.
    The hook owns the mutable state (last reconcile time, slow-link flag,
    output-since-reconcile, held depth); this module owns only the guards. */
export interface ReconcileInput {
  /** The connect-time history seed has landed. */
  seeded: boolean;
  /** A deeper re-seed (scroll-to-top growth or another reconcile) is in
      flight; the live stream is held, so do not pile another request on. */
  expanding: boolean;
  /** New output arrived since the last reconcile — drift only comes from
      new output, so a quiet history must not re-pull the same bytes. */
  outputSinceReconcile: boolean;
  /** xterm buffer geometry: where the viewport sits vs. the live bottom. */
  viewportY: number;
  baseY: number;
  /** When the last scroll-triggered re-pull went out (epoch ms). */
  lastReconcileAt: number;
  /** Current time (epoch ms) — passed in, not read, so the decision is
      testable and uses one clock per call. */
  now: number;
  /** The WebSocket is open and can carry the request. */
  wsOpen: boolean;
  /** The link has proven too slow for a full-depth re-render. */
  slowLink: boolean;
  /** History depth currently held. */
  historyDepth: number;
}

/** Decide whether a scroll event should trigger a transcript re-pull, and
    at what depth. Returns null when any guard says no — the guards are
    ordered cheapest-first and must stay in sync with the hook's semantics:
    never reconcile before the seed lands, while a re-seed is in flight,
    without new output to realign, near the live bottom, inside the cooldown,
    or with the socket down. */
export function decideReconcile(input: ReconcileInput): { depth: number } | null {
  const {
    seeded,
    expanding,
    outputSinceReconcile,
    viewportY,
    baseY,
    lastReconcileAt,
    now,
    wsOpen,
    slowLink,
    historyDepth,
  } = input;
  if (!seeded || expanding) return null;
  if (!outputSinceReconcile) return null; // nothing new to realign
  if (viewportY > baseY - RECONCILE_MIN_OFF_BOTTOM) return null;
  if (now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return null;
  if (!wsOpen) return null;
  // A slow link makes a full-depth re-render expensive just to refresh
  // what is on screen; a shallow pull still realigns it. The explicit
  // scroll-to-top growth is untouched — there the user asked for more, so
  // cost is the price of the request.
  const depth = slowLink ? SLOW_LINK_RECONCILE_DEPTH : historyDepth;
  return { depth };
}

/** How the held history depth reacts to a seed-start payload. The server
    reports what it actually sent: fewer lines than requested (or an explicit
    complete) means the pane has nothing deeper — mark the ceiling reached so
    scroll-to-top stops asking. Comparing against the *requested* depth (not
    the held one) keeps a shallow slow-link reconcile from reading as
    "exhausted" and killing the scroll-to-top growth. */
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
