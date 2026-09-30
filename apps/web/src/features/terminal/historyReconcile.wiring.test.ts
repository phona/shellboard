import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The bug this guards against shipped: historyReconcile.ts arrived with a full
// unit-test suite and was never called from the hook. Every one of those tests
// stayed green while the D7 calibration mechanism was dead code — a policy
// module exercised only by its own tests is not wired up, and nothing else in
// the suite can tell the difference.
//
// The hook cannot be unit-tested here (environment is node: no DOM, no xterm),
// so the wiring itself is asserted structurally. It is a weak check, but it is
// the exact failure mode, and it is cheap.
const hookSource = readFileSync(new URL("./useTerminalWs.ts", import.meta.url), "utf8");

/** What the hook must actually *call* — a bare mention (an import) does not
    count, so each is matched with its call parenthesis. */
const CALLED = ["decideReconcile(", "isSlowTransfer(", "nextHistoryDepthAfterSeedStart("] as const;

/** Policy the hook must pass in rather than hard-code, so the module stays the
    single place the cadence is decided. */
const PASSED_IN = ["RECONCILE_DEPTH", "RECONCILE_SETTLE_MS"] as const;

describe("historyReconcile is wired into the terminal hook", () => {
  for (const call of CALLED) {
    it(`calls ${call.slice(0, -1)}`, () => {
      expect(hookSource).toContain(call);
    });
  }

  for (const name of PASSED_IN) {
    it(`passes ${name} through`, () => {
      expect(hookSource).toContain(name);
    });
  }

  it("drives the reconcile from the scroll handler", () => {
    // The scroll hook is where the decision belongs: reading history is what
    // makes the buffer stale, and the settle debounce lives on that path.
    expect(hookSource).toMatch(/term\.onScroll\([\s\S]*scheduleReconcile\(\)/);
  });

  it("re-arms on live output, not on a timer", () => {
    // Drift only comes from new output. A quiet pane must never re-pull.
    expect(hookSource).toMatch(/outputSinceReconcile = true/);
  });
});
