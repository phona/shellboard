import type { Activity } from "@shellboard/contracts";
import type { TmuxSessionInfo } from "../tmux/tmux.js";

export interface ActivityDerivation {
  activity: Activity;
  lastActivityAt: number | null;
}

/**
 * D3: activity derives from tmux output activity (seconds since last
 * monitored output). Imprecision is accepted by design — this is a UI hint.
 */
export function deriveActivity(info: TmuxSessionInfo | null): ActivityDerivation {
  if (!info) return { activity: "exited", lastActivityAt: null };
  const seconds = info.activitySeconds;
  if (seconds === null) return { activity: "idle", lastActivityAt: null };
  const lastActivityAt = Date.now() - seconds * 1000;
  if (seconds < 3) return { activity: "working", lastActivityAt };
  if (seconds < 10) return { activity: "cooling", lastActivityAt };
  return { activity: "idle", lastActivityAt };
}
