import type { Db } from "../db/db.js";
import type { TmuxService } from "../tmux/tmux.js";
import type { ActivityTracker } from "./tracker.js";

/**
 * Polls tmux on a dedicated socket once per second. Runs in the server
 * process regardless of any browser connection — session monitoring must
 * not depend on the web terminal being open.
 */
export class ActivityObserver {
  private readonly db: Db;
  private readonly tmux: TmuxService;
  private readonly tracker: ActivityTracker;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(db: Db, tmux: TmuxService, tracker: ActivityTracker, intervalMs = 1000) {
    this.db = db;
    this.tmux = tmux;
    this.tracker = tracker;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const sessions = this.db
        .prepare("SELECT id, tmux_name FROM sessions")
        .all() as Array<{ id: string; tmux_name: string }>;
      const infos = await this.tmux.listSessions();
      for (const row of sessions) {
        this.tracker.observe(row.id, infos.get(row.tmux_name) ?? null);
      }
    } finally {
      this.ticking = false;
    }
  }
}
