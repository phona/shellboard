import { execa } from "execa";
import { httpError } from "../errors.js";

export interface TmuxSessionInfo {
  name: string;
  activitySeconds: number | null;
  attached: number;
}

export class TmuxService {
  private readonly socket: string;

  constructor(socket: string) {
    this.socket = socket;
  }

  private args(...rest: string[]): string[] {
    return ["-L", this.socket, ...rest];
  }

  async listSessions(): Promise<Map<string, TmuxSessionInfo>> {
    // window_activity, not session_activity: the session stamp is frozen at
    // creation for single-window sessions (its alert pipeline ignores the
    // active window), while window_activity ticks with every pane output.
    // Both are absolute epoch seconds, converted to age here.
    const result = await execa(
      "tmux",
      this.args(
        "list-sessions",
        "-F",
        "#{session_name}|#{window_activity}|#{session_attached}",
      ),
      { reject: false },
    );
    const map = new Map<string, TmuxSessionInfo>();
    if (result.failed) return map;
    for (const line of result.stdout.split("\n")) {
      const parts = line.split("|");
      const name = parts[0];
      if (!name) continue;
      const raw = Number(parts[1]);
      const attached = Number(parts[2]);
      map.set(name, {
        name,
        activitySeconds: Number.isFinite(raw)
          ? Math.max(0, Date.now() / 1000 - raw)
          : null,
        attached: Number.isFinite(attached) ? attached : 0,
      });
    }
    return map;
  }

  async sessionExists(name: string): Promise<boolean> {
    const result = await execa("tmux", this.args("has-session", "-t", name), {
      reject: false,
    });
    return result.exitCode === 0;
  }

  /**
   * Starts a detached session. `-f /dev/null` only applies when this command
   * boots a fresh tmux server: it guarantees a config-free, deterministic
   * server (user tmux.conf must not affect the shellboard socket, D2).
   */
  async newSession(name: string, cwd: string, command: string[]): Promise<void> {
    await execa(
      "tmux",
      this.args(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        ...command,
      ),
    );
    await this.applySessionOptions(name);
  }

  /**
   * Options every shellboard session runs with:
   * - monitor-activity: feeds the activity observer (D3)
   * - status off: the green status line is dead weight in the web UI — the
   *   sidebar already shows session identity, the web chrome shows time.
   * - mouse off: plain drag stays native browser selection (desktop-style);
   *   wheel scrolling is routed to tmux through the server-side scroll
   *   channel instead of tmux mouse reporting.
   * - set-clipboard + Ms override: tmux copy commands and inner CLIs still
   *   push to the browser clipboard via OSC 52.
   */
  async applySessionOptions(name: string): Promise<void> {
    await execa("tmux", this.args("set-option", "-t", name, "monitor-activity", "on"));
    await execa("tmux", this.args("set-option", "-t", name, "status", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "mouse", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "set-clipboard", "on"));
    // Many distros ship xterm-256color terminfo without the Ms (set
    // clipboard) capability, which silently disables set-clipboard — tmux
    // never emits OSC 52. Assert it explicitly.
    await execa(
      "tmux",
      this.args(
        "set-option",
        "-t",
        name,
        "terminal-overrides",
        "xterm*:Ms=\\E]52;%p1%s;%p2%s\\007",
      ),
    );
  }

  async killSession(name: string): Promise<boolean> {
    const result = await execa("tmux", this.args("kill-session", "-t", name), {
      reject: false,
    });
    return result.exitCode === 0;
  }

  async killServer(): Promise<void> {
    await execa("tmux", this.args("kill-server"), { reject: false });
  }

  /**
   * Types literal text into the session's pane — the "Send to terminal"
   * primitive (D6). No newline, no Enter: the bytes are indistinguishable
   * from keyboard input, the user stays the one who submits. Never call this
   * on a timer or on server-side state; it exists for explicit user actions.
   */
  async sendText(name: string, text: string): Promise<void> {
    const result = await execa(
      "tmux",
      this.args("send-keys", "-t", name, "-l", "--", text),
      { reject: false },
    );
    if (result.failed) {
      throw httpError(409, `cannot send to session: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /**
   * Scrolls a session without mouse reporting: copy-mode entry and scrolling
   * are one chained tmux invocation; re-entering copy-mode does not reset
   * the position (verified on tmux 3.7), so no state pre-check is needed.
   * Wheel requests are coalesced per session, and scrolls share a FIFO with
   * cancelCopyMode so cancels can never overtake a pending scroll.
   */
  private readonly scrollPending = new Map<string, number>();
  private readonly scrollDraining = new Set<string>();
  private readonly opQueues = new Map<string, Promise<void>>();
  private readonly copyModeListeners = new Map<string, (active: boolean) => void>();

  /** Notified whenever a scroll operation enters or leaves copy-mode. */
  setCopyModeListener(name: string, listener: (active: boolean) => void): void {
    this.copyModeListeners.set(name, listener);
  }

  clearCopyModeListener(name: string): void {
    this.copyModeListeners.delete(name);
  }

  private notifyCopyMode(name: string, active: boolean): void {
    this.copyModeListeners.get(name)?.(active);
  }

  scroll(name: string, lines: number): void {
    const merged = Math.max(-60, Math.min(60, (this.scrollPending.get(name) ?? 0) + lines));
    this.scrollPending.set(name, merged);
    if (this.scrollDraining.has(name)) return;
    this.scrollDraining.add(name);
    void this.enqueue(name, async () => {
      this.scrollDraining.delete(name);
      await this.drainScroll(name);
    });
  }

  cancelCopyMode(name: string): Promise<void> {
    return this.enqueue(name, async () => {
      await execa("tmux", this.args("send-keys", "-t", name, "-X", "cancel"), {
        reject: false,
      });
      this.notifyCopyMode(name, false);
    });
  }

  async isInCopyMode(name: string): Promise<boolean> {
    const result = await execa(
      "tmux",
      this.args("display-message", "-p", "-t", name, "#{pane_in_mode}"),
    );
    return result.stdout.trim() === "1";
  }

  private enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const prev = this.opQueues.get(name) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.opQueues.set(name, next);
    void next.catch(() => {});
    void next.finally(() => {
      if (this.opQueues.get(name) === next) this.opQueues.delete(name);
    });
    return next;
  }

  private async drainScroll(name: string): Promise<void> {
    for (;;) {
      const lines = this.scrollPending.get(name) ?? 0;
      if (lines === 0) {
        this.scrollPending.delete(name);
        return;
      }
      this.scrollPending.set(name, 0);
      try {
        await this.applyScroll(name, lines);
      } catch {
        // dead session — drop the rest
        this.scrollPending.delete(name);
        return;
      }
    }
  }

  private async applyScroll(name: string, lines: number): Promise<void> {
    if (lines > 0) {
      // -H hides the copy-mode position indicator (e.g. [40/451]) — the web
      // HISTORY bar already conveys the mode. Re-entering copy-mode does not
      // reset the scroll position (verified on tmux 3.7).
      await execa(
        "tmux",
        this.args("copy-mode", "-H", "-t", name, ";", "send-keys", "-t", name, "-X", "-N", String(lines), "scroll-up"),
      );
      this.notifyCopyMode(name, true);
      return;
    }
    await execa("tmux", this.args("send-keys", "-t", name, "-X", "-N", String(-lines), "scroll-down"), {
      reject: false,
    });
    const position = await execa(
      "tmux",
      this.args("display-message", "-p", "-t", name, "#{scroll_position}"),
      { reject: false },
    );
    if (position.stdout.trim() === "0") {
      // tmux's own lifecycle: back at the bottom, copy-mode exits
      await execa("tmux", this.args("send-keys", "-t", name, "-X", "cancel"), {
        reject: false,
      });
      this.notifyCopyMode(name, false);
    }
  }
}
