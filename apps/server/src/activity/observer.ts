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
        .prepare(
          "SELECT sessions.id, sessions.tmux_name, projects.location FROM sessions JOIN projects ON projects.id = sessions.project_id",
        )
        .all() as Array<{ id: string; tmux_name: string; location: string }>;
      const result = await this.tmux.listSessionsResult();
      if (!result.ok) {
        for (const row of sessions) {
          this.tracker.markUnknown(row.id, row.location === "ssh");
        }
        return;
      }
      for (const row of sessions) {
        this.tracker.observe(
          row.id,
          result.sessions.get(row.tmux_name) ?? null,
          row.location === "ssh",
        );
      }
    } catch (err) {
      // start() fires this with `void`, so a throw here would surface as an
      // unhandled rejection and kill the process under Node's default
      // --unhandled-rejections=throw. Observation is best-effort: log and
      // let the next tick retry.
      console.warn(`[activity] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
