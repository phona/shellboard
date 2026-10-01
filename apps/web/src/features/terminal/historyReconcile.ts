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

    This module owns only the guards and the depth policy. The hook owns the
    mutable state (last reconcile time, slow-link flag, output-since-reconcile,
    whether the user has scrolled since the last re-seed); everything the
    decision needs is passed in as plain data so it is testable off one clock. */

/** A reconcile pulls only as deep as the reader actually is. A fixed depth
    fails in both directions: too shallow and the seed does not reach a reader
    who is far up in history, so the restore clamps and they are thrown to the
    top of a buffer that does not contain what they were reading — which reads
    as "the repair did nothing". Too deep and every repair near the live edge
    pays for history nobody is looking at, on a link where that is the dominant
    cost.

    The floor is deliberately the old fixed depth, not lower: a reconcile
    replaces the whole buffer, so whatever it pulls is all the history the
    reader has afterwards. A floor below the previous behaviour would make
    every repair silently shorten their transcript. */
export const RECONCILE_MIN_DEPTH = 500;

/** Context below the reader, so the repair is not a viewport-sized slit. */
export const RECONCILE_CONTEXT_LINES = 40;

/** Ceiling. Past this the reader is doing deep archaeology, which the
    scroll-to-top path exists for — it is their explicit request and grows the
    buffer for good, unlike a reconcile that drops it again. */
export const RECONCILE_MAX_DEPTH = 800;

/** Scroll must settle for this long before a reconcile may fire. A user still
    scrolling must never have the buffer swapped underneath them. The rest of
    the repair costs ~30ms (capture 8ms, client repaint ~20ms), so a long
    settle buys nothing and is most of what the reader waits. */
export const RECONCILE_SETTLE_MS = 400;

/** Backstop cooldown between automatic reconciles. The gesture requirement
    bounds this to one per scroll-stop, but a touch reader adjusts in small
    frequent steps, so without a real cooldown every adjustment after the
    gesture gate re-opens is another full buffer clear — perceived as the
    terminal flickering several times before it settles. */
export const RECONCILE_MIN_INTERVAL_MS = 12_000;

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

/** A reconcile only fires once the pane has been quiet for this long. A
    repaint-heavy agent redraws continuously, and a snapshot taken while it
    does is a whole but half-written state — which reaches the reader as a
    message cut off mid-sentence, completed a moment later when the live
    stream catches up. Repairing a drifting buffer is only worth it when the
    result will not itself be truncated, so wait for the pane to settle; a
    pane that repaints without pause is repaired the moment it stops. */
export const RECONCILE_QUIET_MS = 500;

/** How deep a reconcile should pull for a reader this far above the live
    bottom. Covers the reader, their viewport, and a little context. */
export function reconcileDepth(offsetFromBottom: number, rows: number): number {
  const wanted = offsetFromBottom + rows + RECONCILE_CONTEXT_LINES;
  return Math.min(RECONCILE_MAX_DEPTH, Math.max(RECONCILE_MIN_DEPTH, wanted));
}

/** Whether a re-seed actually put the reader back where they were.

    A restore clamps when the seed did not reach them — they were deeper in
    history than the capture covered. That repair did not do its job, so it
    must not count as one: the gesture gate has to stay open for a retry,
    otherwise the reader waits forever for a repair that already failed. */
export function restoreCoveredReader(
  previous: { viewportY: number; baseY: number },
  newBaseY: number,
): boolean {
  return newBaseY >= previous.baseY - previous.viewportY;
}

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
  /** The user has scrolled since the last re-seed, or the last re-seed failed
      to reach them. Without this a single reconcile would re-arm itself
      forever on a streaming pane: every re-seed leaves stale content again as
      soon as the next repaint lands, and the terminal would strobe between
      two buffers once per cooldown. */
  gesturedSinceReseed: boolean;
  /** Milliseconds since the last byte arrived from the server. A pane still
      producing output is mid-repaint, and a snapshot of it is truncated. */
  quietForMs: number;
  /** How far the viewport sits above the live bottom. */
  offsetFromBottom: number;
  /** Terminal height, so the pulled depth covers the viewport and not just
      the reader's row. */
  rows: number;
  /** When the last re-seed went out (epoch ms). */
  lastReconcileAt: number;
  /** Current time (epoch ms) — passed in, not read, so the decision is
      testable and uses one clock per call. */
  now: number;
  /** The WebSocket is open and can carry the request. */
  wsOpen: boolean;
  /** The link has proven too slow for a full re-render; reconciles back off. */
  slowLink: boolean;
}

/** Decide whether a settled scroll should trigger a transcript re-pull, and
    at what depth. Returns null when any guard says no — the guards are
    ordered cheapest-first and must stay in sync with the hook's semantics:
    never reconcile before the seed lands, while a re-seed is in flight,
    without new output to realign, without a scroll or a failed repair to ask
    for it, while the pane is still producing output, near the live bottom,
    inside the cooldown, or with the socket down. */
export function decideReconcile(input: ReconcileInput): { depth: number } | null {
  const {
    seeded,
    expanding,
    outputSinceReconcile,
    gesturedSinceReseed,
    quietForMs,
    offsetFromBottom,
    rows,
    lastReconcileAt,
    now,
    wsOpen,
    slowLink,
  } = input;
  if (!seeded || expanding) return null;
  if (!outputSinceReconcile) return null; // nothing new to realign
  if (!gesturedSinceReseed) return null; // one clean-up per scroll-stop
  if (quietForMs < RECONCILE_QUIET_MS) return null; // pane still repainting
  if (offsetFromBottom < RECONCILE_MIN_OFF_BOTTOM) return null;
  // A reader this far up cannot be reached by a capped pull. Repairing anyway
  // would clamp the restore and flicker for nothing, over and over — the
  // scroll-to-top growth path is the right tool there, and it is the reader's
  // own explicit request.
  if (offsetFromBottom > RECONCILE_MAX_DEPTH) return null;
  const cooldown = slowLink ? SLOW_LINK_RECONCILE_INTERVAL_MS : RECONCILE_MIN_INTERVAL_MS;
  if (now - lastReconcileAt < cooldown) return null;
  if (!wsOpen) return null;
  return { depth: reconcileDepth(offsetFromBottom, rows) };
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

/** Depth that covers a reader this far above the live bottom, for the retry
    after a restore clamped. The scroll-to-top ladder multiplies by three,
    which suits a reader asking deliberately for more — but a retry is the
    client answering a request it just failed, so it asks for exactly what it
    needs in one round instead of clearing the buffer two or three times. */
export function coveringDepth(offsetFromBottom: number, rows: number): number {
  return Math.min(MAX_HISTORY_LINES, offsetFromBottom + rows + RECONCILE_CONTEXT_LINES);
}

/** Where the viewport should land after a re-seed replaces the buffer.

    The seed is a snapshot, so `baseY` moves with whatever depth it happened
    to carry — deeper, equal, or shallower than the buffer it replaced. What
    the user chose is not a row number but a *distance from the live bottom*,
    and that distance is invariant under all three, so it is the only thing
    worth anchoring on.

    The previous implementation anchored on the number of lines the server
    reported having sent (`seedLines - baseY`), which silently assumed the new
    seed is deeper. A shallow reconcile delivers fewer lines than the buffer
    it replaces, so the anchor went negative and clamped to the top of a short
    buffer — the user was thrown to the head of the history they were reading.
    Distance from the bottom is also exact geometry rather than an
    approximation of it: the server's line count excludes the visible screen,
    so it under-reports by up to `rows`. */
export function restoredViewportY(
  previous: { viewportY: number; baseY: number },
  newBaseY: number,
): number {
  const offsetFromBottom = previous.baseY - previous.viewportY;
  return Math.max(0, Math.min(newBaseY - offsetFromBottom, newBaseY));
}
