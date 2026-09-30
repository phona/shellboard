import { describe, expect, it } from "vitest";
import {
  decideReconcile,
  isSlowTransfer,
  MAX_HISTORY_LINES,
  nextHistoryDepthAfterSeedStart,
  type ReconcileInput,
} from "./historyReconcile";

// Reader up in history: 100 lines above the live bottom, seeded, output
// arrived, cooldown long past, socket open.
function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    seeded: true,
    expanding: false,
    outputSinceReconcile: true,
    viewportY: 100,
    baseY: 200,
    lastReconcileAt: 0,
    now: 10_000,
    wsOpen: true,
    slowLink: false,
    historyDepth: 4990,
    ...overrides,
  };
}

describe("decideReconcile (scroll-triggered re-pull)", () => {
  it("re-pulls at the held depth when up in history with new output", () => {
    expect(decideReconcile(input())).toEqual({ depth: 4990 });
  });

  it("drops to the shallow depth once the link proved slow", () => {
    expect(decideReconcile(input({ slowLink: true }))).toEqual({ depth: 1000 });
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

  it("never fires at the live bottom", () => {
    expect(decideReconcile(input({ viewportY: 200 }))).toBeNull();
  });

  it("stays quiet one line short of the off-bottom threshold", () => {
    expect(decideReconcile(input({ viewportY: 193 }))).toBeNull();
  });

  it("stays quiet inside the cooldown", () => {
    expect(decideReconcile(input({ lastReconcileAt: 5001, now: 10_000 }))).toBeNull();
  });

  it("stays quiet with the socket down", () => {
    expect(decideReconcile(input({ wsOpen: false }))).toBeNull();
  });

  it("fires exactly at the off-bottom threshold", () => {
    expect(decideReconcile(input({ viewportY: 192 }))).toEqual({ depth: 4990 });
  });

  it("fires exactly when the cooldown has elapsed", () => {
    expect(decideReconcile(input({ lastReconcileAt: 5000, now: 10_000 }))).toEqual({
      depth: 4990,
    });
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

  it("does not read a shallow slow-link reconcile as exhausted", () => {
    // Regression: a slow-link reconcile asks for 1000 lines and gets exactly
    // 1000 back — the pane is not exhausted, the request was. Comparing
    // against the requested depth (not the held one) keeps the scroll-to-top
    // growth alive.
    expect(nextHistoryDepthAfterSeedStart(1000, false, 1000, 4990)).toBe(4990);
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
