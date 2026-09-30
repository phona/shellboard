import { describe, expect, it } from "vitest";
import {
  decideReconcile,
  isSlowTransfer,
  MAX_HISTORY_LINES,
  nextHistoryDepthAfterSeedStart,
  RECONCILE_MAX_DEPTH,
  RECONCILE_MIN_DEPTH,
  RECONCILE_MIN_INTERVAL_MS,
  RECONCILE_QUIET_MS,
  reconcileDepth,
  restoreCoveredReader,
  restoredViewportY,
  SLOW_LINK_RECONCILE_INTERVAL_MS,
  type ReconcileInput,
} from "./historyReconcile";

// Reader 600 lines above the live bottom — far enough up that the depth is set
// by the reader rather than by the floor. Seeded, output arrived, the user
// scrolled since the last re-seed, cooldown long past, socket open, 24 rows.
function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    seeded: true,
    expanding: false,
    outputSinceReconcile: true,
    gesturedSinceReseed: true,
    quietForMs: 10_000,
    offsetFromBottom: 600,
    rows: 24,
    lastReconcileAt: 0,
    now: 10_000,
    wsOpen: true,
    slowLink: false,
    ...overrides,
  };
}

describe("decideReconcile (scroll-triggered re-pull)", () => {
  it("pulls deep enough to reach the reader, not a fixed depth", () => {
    // 600 above the bottom + 24 rows + 40 context.
    expect(decideReconcile(input())).toEqual({ depth: 664 });
  });

  it("pulls the floor for a shallow reader rather than shrinking the buffer", () => {
    // 30 + 24 + 40 = 94, below the floor, so the floor wins. A reconcile
    // replaces the whole buffer, so a lower floor would make every repair
    // silently shorten the transcript.
    expect(decideReconcile(input({ offsetFromBottom: 30, rows: 24 }))).toEqual({
      depth: RECONCILE_MIN_DEPTH,
    });
    expect(decideReconcile(input({ offsetFromBottom: 8, rows: 24 }))).toEqual({
      depth: RECONCILE_MIN_DEPTH,
    });
  });

  it("stays shallow even on a fast link — the depth is not link-dependent", () => {
    // Regression: the depth used to follow slowLink, which made the fast path
    // re-pull the whole held depth and clear a large buffer to fix a few
    // lines on screen.
    expect(decideReconcile(input({ slowLink: false }))).toEqual({ depth: 664 });
  });

  it("backs off to the longer cooldown once the link proved slow", () => {
    // Past the fast cooldown but inside the slow one: a fast link fires here,
    // a slow link stays quiet so a weak connection is not spent re-rendering
    // history the user is still reading.
    const pastFastCooldown = {
      lastReconcileAt: 10_000 - RECONCILE_MIN_INTERVAL_MS - 1,
      now: 10_000,
    };
    expect(decideReconcile(input(pastFastCooldown))).toEqual({ depth: 664 });
    expect(decideReconcile(input({ slowLink: true, ...pastFastCooldown }))).toBeNull();

    // Exactly at the slow cooldown it fires again.
    expect(
      decideReconcile(
        input({
          slowLink: true,
          lastReconcileAt: 10_000 - SLOW_LINK_RECONCILE_INTERVAL_MS,
          now: 10_000,
        }),
      ),
    ).toEqual({ depth: 664 });
  });

  it("never fires before the connect-time seed has landed", () => {
    expect(decideReconcile(input({ seeded: false }))).toBeNull();
  });

  it("never piles onto a re-seed already in flight", () => {
    expect(decideReconcile(input({ expanding: true }))).toBeNull();
  });

  it("stays quiet when no output has arrived to realign", () => {
    expect(decideReconcile(input({ outputSinceReconcile: false }))).toBeNull();
  });

  it("fires once per scroll-stop, not once per cooldown", () => {
    // Regression: without this guard a streaming pane re-armed the reconcile
    // forever — the re-seed leaves stale content again as soon as the next
    // repaint lands, so the buffer strobed once per cooldown.
    expect(decideReconcile(input({ gesturedSinceReseed: false }))).toBeNull();
  });

  it("never fires at the live bottom", () => {
    expect(decideReconcile(input({ offsetFromBottom: 0 }))).toBeNull();
  });

  it("stays quiet one line short of the off-bottom threshold", () => {
    expect(decideReconcile(input({ offsetFromBottom: 7 }))).toBeNull();
  });

  it("stays quiet inside the cooldown", () => {
    expect(
      decideReconcile(input({ lastReconcileAt: 10_000 - RECONCILE_MIN_INTERVAL_MS + 1, now: 10_000 })),
    ).toBeNull();
  });

  it("stays quiet with the socket down", () => {
    expect(decideReconcile(input({ wsOpen: false }))).toBeNull();
  });

  it("fires exactly at the off-bottom threshold", () => {
    expect(decideReconcile(input({ offsetFromBottom: 8 }))).toEqual({
      depth: RECONCILE_MIN_DEPTH,
    });
  });

  it("fires exactly when the cooldown has elapsed", () => {
    expect(
      decideReconcile(input({ lastReconcileAt: 10_000 - RECONCILE_MIN_INTERVAL_MS, now: 10_000 })),
    ).toEqual({ depth: 664 });
  });

  it("stays quiet while the pane is still producing output", () => {
    // A snapshot of a repainting pane is a half-written state: the reader sees
    // a message cut off mid-sentence, completed a moment later by the live
    // stream. Wait for the pane to settle instead.
    expect(decideReconcile(input({ quietForMs: RECONCILE_QUIET_MS - 1 }))).toBeNull();
    expect(decideReconcile(input({ quietForMs: RECONCILE_QUIET_MS }))).toEqual({ depth: 664 });
  });

  it("stays quiet for a reader the cap cannot reach", () => {
    // A capped pull would clamp the restore and flicker for nothing. That
    // reader belongs to the scroll-to-top growth path, which is their own
    // explicit request and grows the buffer for good.
    expect(decideReconcile(input({ offsetFromBottom: RECONCILE_MAX_DEPTH }))).toEqual({
      depth: RECONCILE_MAX_DEPTH,
    });
    expect(decideReconcile(input({ offsetFromBottom: RECONCILE_MAX_DEPTH + 1 }))).toBeNull();
    expect(decideReconcile(input({ offsetFromBottom: 5000 }))).toBeNull();
  });
});

describe("reconcileDepth (how deep a repair pulls)", () => {
  it("covers the reader, the viewport and context above the floor", () => {
    expect(reconcileDepth(600, 24)).toBe(664);
  });

  it("never pulls less than the floor", () => {
    // The floor is the previous fixed depth: a reconcile replaces the buffer,
    // so pulling less than before would shorten every transcript it repairs.
    expect(reconcileDepth(0, 24)).toBe(RECONCILE_MIN_DEPTH);
    expect(reconcileDepth(30, 24)).toBe(RECONCILE_MIN_DEPTH);
    expect(reconcileDepth(10, 1)).toBe(RECONCILE_MIN_DEPTH);
  });

  it("never pulls more than the ceiling", () => {
    expect(reconcileDepth(100_000, 24)).toBe(RECONCILE_MAX_DEPTH);
    expect(reconcileDepth(800, 24)).toBe(RECONCILE_MAX_DEPTH);
  });

  it("grows with the reader, so a deep reader is reached", () => {
    // The failure the adaptive depth exists for: a fixed 500-line pull for a
    // reader 700 lines up clamped the restore to the top of a buffer that did
    // not contain them, which read as "the repair did nothing".
    const depth = reconcileDepth(700, 24);
    expect(depth).toBeGreaterThan(700);
    expect(restoreCoveredReader({ viewportY: 0, baseY: 700 }, depth)).toBe(true);
  });

  it("stops covering a reader past the ceiling", () => {
    // 800 + 24 + 40 is past the ceiling, so the pull is capped. A reader that
    // far up is not reached — which is why decideReconcile refuses them
    // instead of clamping and flickering for nothing.
    expect(reconcileDepth(800, 24)).toBe(RECONCILE_MAX_DEPTH);
    expect(restoreCoveredReader({ viewportY: 0, baseY: 800 }, RECONCILE_MAX_DEPTH)).toBe(true);
    expect(restoreCoveredReader({ viewportY: 0, baseY: 900 }, RECONCILE_MAX_DEPTH)).toBe(false);
  });
});

describe("restoreCoveredReader (did the repair reach them)", () => {
  const reader = { viewportY: 100, baseY: 200 }; // 100 above the bottom

  it("is covered when the seed reaches the reader's offset", () => {
    expect(restoreCoveredReader(reader, 100)).toBe(true);
    expect(restoreCoveredReader(reader, 300)).toBe(true);
  });

  it("is not covered when the seed stops short of the reader", () => {
    expect(restoreCoveredReader(reader, 99)).toBe(false);
    expect(restoreCoveredReader(reader, 40)).toBe(false);
  });

  it("is covered for a reader at the live bottom", () => {
    expect(restoreCoveredReader({ viewportY: 200, baseY: 200 }, 0)).toBe(true);
  });
});

describe("restoredViewportY (reading position across a re-seed)", () => {
  // The reader sits 40 lines above the live bottom of a 200-line buffer.
  const reader = { viewportY: 160, baseY: 200 };

  it("keeps the position when the seed is the same depth", () => {
    expect(restoredViewportY(reader, 200)).toBe(160);
  });

  it("shifts down by exactly the lines a deeper seed added", () => {
    // 100 more lines of history: everything the reader was looking at moves
    // down by 100, and so does the anchor.
    expect(restoredViewportY(reader, 300)).toBe(260);
  });

  it("keeps the distance from the bottom when the seed is shallower", () => {
    // The regression this function exists for. A shallow reconcile replaces a
    // 200-line buffer with a 60-line one; the reader was 40 lines above the
    // bottom, so they stay 40 lines above the bottom — not thrown to row 0.
    expect(restoredViewportY(reader, 60)).toBe(20);
  });

  it("clamps to the top when the reader was above the whole new buffer", () => {
    expect(restoredViewportY({ viewportY: 0, baseY: 200 }, 60)).toBe(0);
  });

  it("stays at the live bottom for a reader who never left it", () => {
    expect(restoredViewportY({ viewportY: 200, baseY: 200 }, 300)).toBe(300);
    expect(restoredViewportY({ viewportY: 200, baseY: 200 }, 60)).toBe(60);
  });

  it("clamps to the new bottom when the anchor would overshoot", () => {
    // Defensive only: a viewport below baseY cannot happen in xterm, but the
    // upper clamp is what keeps a corrupt reading position from scrolling the
    // viewport past the end of the buffer.
    expect(restoredViewportY({ viewportY: 210, baseY: 200 }, 300)).toBe(300);
  });

  it("handles an empty buffer", () => {
    expect(restoredViewportY({ viewportY: 0, baseY: 0 }, 0)).toBe(0);
  });

  it("is exact where the old line-count anchor drifted by a screen", () => {
    // The old math was `viewportY + seedLines - baseY`. The server's `lines`
    // counts history only and excludes the visible screen, so it under-reports
    // by up to `rows` — the anchor therefore drifted by exactly that much on
    // every re-seed, and a drift that accumulates is what starts rows landing
    // on the wrong line.
    const oldAnchor = (prev: { viewportY: number; baseY: number }, seedLines: number, newBaseY: number) =>
      Math.max(0, Math.min(prev.viewportY + seedLines - prev.baseY, newBaseY));

    // A 488-line history seed into a 12-row screen lands the buffer at baseY
    // 500. The reader should still be 40 lines above the bottom: row 460.
    const newBaseY = 500;
    expect(restoredViewportY(reader, newBaseY)).toBe(460);
    expect(oldAnchor(reader, 488, newBaseY)).toBe(448); // 12 lines off — one screen
  });
});

describe("nextHistoryDepthAfterSeedStart (seed-start payload)", () => {
  it("marks the ceiling when the pane reports complete", () => {
    expect(nextHistoryDepthAfterSeedStart(undefined, true, 4990, 4990)).toBe(MAX_HISTORY_LINES);
  });

  it("marks the ceiling when fewer lines arrived than requested", () => {
    expect(nextHistoryDepthAfterSeedStart(103, false, 4990, 4990)).toBe(MAX_HISTORY_LINES);
  });

  it("keeps the held depth when the server sent exactly what was asked", () => {
    expect(nextHistoryDepthAfterSeedStart(4990, false, 4990, 4990)).toBe(4990);
  });

  it("keeps the held depth when the line count is absent", () => {
    expect(nextHistoryDepthAfterSeedStart(undefined, false, 4990, 4990)).toBe(4990);
  });

  it("keeps the held depth for a zero-line count", () => {
    expect(nextHistoryDepthAfterSeedStart(0, false, 1000, 4990)).toBe(4990);
  });

  it("does not read a shallow reconcile as exhausted", () => {
    // Regression: a reconcile asks for 664 lines and gets exactly that many
    // back — the pane is not exhausted, the request was. Comparing against
    // the requested depth (not the held one) keeps the scroll-to-top growth
    // alive.
    expect(nextHistoryDepthAfterSeedStart(664, false, 664, 4990)).toBe(4990);
  });
});

describe("isSlowTransfer (re-push cost)", () => {
  it("treats exactly the threshold as fast", () => {
    expect(isSlowTransfer(0, 1000)).toBe(false);
  });

  it("flags one millisecond past the threshold", () => {
    expect(isSlowTransfer(0, 1001)).toBe(true);
  });

  it("never flags a zero or negative elapsed time", () => {
    expect(isSlowTransfer(0, 0)).toBe(false);
    expect(isSlowTransfer(1000, 999)).toBe(false);
  });
});
