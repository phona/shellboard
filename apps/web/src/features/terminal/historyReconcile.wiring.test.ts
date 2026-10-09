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
const PASSED_IN = ["RECONCILE_SETTLE_MS"] as const;

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

  it("grows the buffer when the reader scrolls into history at the top", () => {
    // Regression: growth was only reachable from onScroll, and scrollLines
    // cannot move the viewport from row 0 — so a reader already at the top
    // scrolling further fired no event at all and the terminal was stuck.
    expect(hookSource).toMatch(/viewportY <= 0\)\s*\{[\s\S]*maybeExpandHistory\(\)/);
  });

  it("grows the buffer when a re-seed clamped the reader's position", () => {
    // Regression: a reconcile that did not reach the reader left them at the
    // top of a short buffer with no way to ask for more. It asks for the depth
    // that covers them, not the x3 ladder — each ladder round is another full
    // buffer clear, which is the "flickers several times" report.
    expect(hookSource).toMatch(
      /restoreCoveredReader\(from, buf\.baseY\)\)\s*\{[\s\S]*maybeExpandHistory\(coveringDepth\(/,
    );
  });
});

describe("a re-seed wipes the buffer with the seed bytes already in hand", () => {
  // The wipe used to hang off the seed-start control frame, one socket frame
  // before the seed itself. The reader therefore watched a blank terminal for
  // as long as that frame took to arrive, then a full repaint, then the seed —
  // three visible steps for one buffer replacement (REMOTE-TERMINAL 4.1 costs
  // the repaint at 20.6 ms). xterm batches every refresh into one
  // requestAnimationFrame, so wiping next to the write coalesces the two
  // repaints: the reader watches the seed paint in instead of a blank screen
  // painted and then replaced.
  // The wipe now goes through wipeBuffer(), which restores the pane's input
  // modes around xterm's reset() (inputModes.wiring.test.ts); what is
  // asserted here is unchanged — WHEN the buffer is cleared, not how.
  const seedBranch = hookSource.slice(hookSource.indexOf("if (expectingSeed) {"));
  const controlFrameBranch = hookSource.slice(
    hookSource.indexOf('message.type === "seed-start"'),
  );
  const seedWipeAt = seedBranch.indexOf("wipeBuffer()");

  it("clears the buffer before writing the seed, not on the control frame", () => {
    expect(seedWipeAt).toBeGreaterThan(-1);
    expect(seedWipeAt).toBeLessThan(
      seedBranch.indexOf("term.write(new Uint8Array(event.data)"),
    );
  });

  it("wipes on the control frame only for a seed that carries no bytes", () => {
    // A zero-line seed has no body of its own — its bytes come through the
    // live-output path, so there is nothing to synchronize the wipe with and it
    // has to happen on the control frame. Any seed that does carry a body must
    // not clear a buffer the reader is looking at while that body is still in
    // flight: the guard has to come before the wipe, or the wipe is unconditional.
    const beforeWipe = controlFrameBranch.slice(0, controlFrameBranch.indexOf("wipeBuffer()"));
    expect(beforeWipe).toContain("expectingSeed = message.lines !== 0");
    // And there has to be one at all: a pane with no history still has a screen,
    // and that screen is the only thing this re-seed delivers.
    expect(controlFrameBranch.indexOf("wipeBuffer()")).toBeGreaterThan(-1);
  });
});
