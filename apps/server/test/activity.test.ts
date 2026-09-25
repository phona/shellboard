import { expect, it } from "vitest";
import { deriveActivity } from "../src/activity/derive";
import type { TmuxSessionInfo } from "../src/tmux/tmux";

function info(activitySeconds: number | null): TmuxSessionInfo {
  return { name: "x", activitySeconds, attached: 0 };
}

describe("deriveActivity (D3 thresholds)", () => {
  it("maps missing session to exited", () => {
    expect(deriveActivity(null).activity).toBe("exited");
    expect(deriveActivity(null).lastActivityAt).toBeNull();
  });

  it("maps recent output to working", () => {
    const result = deriveActivity(info(1));
    expect(result.activity).toBe("working");
    expect(result.lastActivityAt).not.toBeNull();
  });

  it("maps 3..10s to cooling", () => {
    expect(deriveActivity(info(4)).activity).toBe("cooling");
    expect(deriveActivity(info(9)).activity).toBe("cooling");
  });

  it("maps quiet sessions to idle", () => {
    expect(deriveActivity(info(10)).activity).toBe("idle");
    expect(deriveActivity(info(600)).activity).toBe("idle");
  });

  it("treats unknown activity time as idle", () => {
    expect(deriveActivity(info(null)).activity).toBe("idle");
  });
});
