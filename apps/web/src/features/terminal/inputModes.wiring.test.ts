import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The bug this guards against shipped: a history re-seed wiped the client
// buffer with term.reset(), which also cleared xterm's tracked private modes,
// and nothing re-asserted them. The pane app sets them once at startup, tmux
// only broadcasts mode state on attach, and a seed is capture-pane text — so
// from the first re-seed onward xterm believed bracketed paste was off and
// sent every multi-line paste as bare newlines. The user watched one prompt
// become a dozen submitted messages.
//
// The hook cannot run here (node: no DOM, no xterm), so the wiring is asserted
// structurally — the same trade historyReconcile.wiring.test.ts makes.
const hookSource = readFileSync(new URL("./useTerminalWs.ts", import.meta.url), "utf8");

describe("a buffer wipe preserves the pane's input modes", () => {
  it("snapshots the modes before the wipe", () => {
    expect(hookSource).toContain("inputModeSequences(term.modes)");
  });

  it("resets through the helper, so a wipe cannot lose the modes", () => {
    // One reset() in the whole hook, inside the helper: a future wipe site
    // calling term.reset() directly would reintroduce the loss.
    expect(hookSource.match(/term\.reset\(\)/g)?.length).toBe(1);
    expect(hookSource).toContain("const wipeBuffer = (): void => {");
    expect(hookSource).toMatch(
      /const restore = inputModeSequences\(term\.modes\);\s*\n\s*term\.reset\(\);/,
    );
  });

  it("re-applies the modes after the wipe, not before it", () => {
    const start = hookSource.indexOf("const wipeBuffer");
    const body = hookSource.slice(start, hookSource.indexOf("};", start));
    expect(body.indexOf("term.reset()")).toBeGreaterThan(-1);
    expect(body.indexOf("term.reset()")).toBeLessThan(body.indexOf("term.write(restore)"));
  });

  it("uses the same wipe for both seed paths", () => {
    // The connect-time seed and every re-seed are two code paths with the
    // same hazard; the zero-line seed wipe must be the same helper.
    expect(hookSource.match(/wipeBuffer\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
