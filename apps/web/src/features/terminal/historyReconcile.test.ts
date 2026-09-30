import { describe, expect, it } from "vitest";
import {
  decideReconcile,
  isSlowTransfer,
  MAX_HISTORY_LINES,
  nextHistoryDepthAfterSeedStart,
  RECONCILE_DEPTH,
  RECONCILE_MIN_INTERVAL_MS,
  SLOW_LINK_RECONCILE_INTERVAL_MS,
  type ReconcileInput,
} from "./historyReconcile";

// Reader up in history: 100 lines above the live bottom, seeded, output
// arrived, the user scrolled since the last re-seed, cooldown long past,
// socket open.
function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    seeded: true,
    expanding: false,
    outputSinceReconcile: true,
    gesturedSinceReseed: true,
    viewportY: 100,
    baseY: 200,
    lastReconcileAt: 0,
    now: 10_000,
    wsOpen: true,
    slowLink: false,
    reconcileDepth: RECONCILE_DEPTH,
    ...overrides,
  };
}

describe("decideReconcile (scroll-triggered re-pull)", () => {
  it("re-pulls at the shallow depth when up in history with new output", () => {
    expect(decideReconcile(input())).toEqual({ depth: RECONCILE_DEPTH });
  });

  it("stays shallow even on a fast link — the depth is not link-dependent", () => {
    // Regression: the depth used to follow slowLink, which made the fast path
    // re-pull the whole held depth and clear a large buffer to fix a few
    // lines on screen.
    expect(decideReconcile(input({ slowLink: false }))).toEqual({
      depth: RECONCILE_DEPTH,
    });
  });

  it("backs off to the longer cooldown once the link proved slow", () => {
    // Past the fast cooldown but inside the slow one: a fast link fires here,
    // a slow link stays quiet so a weak connection is not spent re-rendering
    // history the user is still reading.
    const pastFastCooldown = {
      lastReconcileAt: 10_000 - RECONCILE_MIN_INTERVAL_MS - 1,
      now: 10_000,
    };
    expect(decideReconcile(input(pastFastCooldown))).toEqual({ depth: RECONCILE_DEPTH });
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
    ).toEqual({ depth: RECONCILE_DEPTH });
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
    expect(decideReconcile(input({ viewportY: 200 }))).toBeNull();
  });

  it("stays quiet one line short of the off-bottom threshold", () => {
    expect(decideReconcile(input({ viewportY: 193 }))).toBeNull();
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
    expect(decideReconcile(input({ viewportY: 192 }))).toEqual({ depth: RECONCILE_DEPTH });
  });

  it("fires exactly when the cooldown has elapsed", () => {
    expect(
      decideReconcile(input({ lastReconcileAt: 10_000 - RECONCILE_MIN_INTERVAL_MS, now: 10_000 })),
    ).toEqual({ depth: RECONCILE_DEPTH });
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
    // Regression: a reconcile asks for RECONCILE_DEPTH lines and gets exactly
    // that many back — the pane is not exhausted, the request was. Comparing
    // against the requested depth (not the held one) keeps the scroll-to-top
    // growth alive.
    expect(nextHistoryDepthAfterSeedStart(RECONCILE_DEPTH, false, RECONCILE_DEPTH, 4990)).toBe(4990);
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
