import { execa } from "execa";

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
    const result = await execa(
      "tmux",
      this.args(
        "list-sessions",
        "-F",
        "#{session_name}|#{session_activity}|#{session_attached}",
      ),
      { reject: false },
    );
    const map = new Map<string, TmuxSessionInfo>();
    if (result.failed) return map;
    for (const line of result.stdout.split("\n")) {
      const parts = line.split("|");
      const name = parts[0];
      if (!name) continue;
      const activity = Number(parts[1]);
      const attached = Number(parts[2]);
      map.set(name, {
        name,
        activitySeconds: Number.isFinite(activity) ? activity : null,
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
   * - mouse off: plain drag stays native browser selection (desktop-style);
   *   wheel scrolling is routed to tmux through the server-side scroll
   *   channel instead of tmux mouse reporting.
   * - set-clipboard + Ms override: tmux copy commands and inner CLIs still
   *   push to the browser clipboard via OSC 52.
   */
  async applySessionOptions(name: string): Promise<void> {
    await execa("tmux", this.args("set-option", "-t", name, "monitor-activity", "on"));
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
   * Scrolls a session without mouse reporting: wheel up enters copy-mode and
   * scrolls, wheel down scrolls back and exits at the bottom (same lifecycle
   * as tmux's own mouse wheel). Requests are coalesced per session because
   * wheel events arrive faster than tmux commands complete.
   */
  private readonly scrollPending = new Map<string, number>();

  scroll(name: string, lines: number): void {
    const merged = Math.max(-60, Math.min(60, (this.scrollPending.get(name) ?? 0) + lines));
    this.scrollPending.set(name, merged);
    if (merged !== lines) return; // a run loop is already scheduled
    void this.runScroll(name);
  }

  private async runScroll(name: string): Promise<void> {
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
    const inMode = async (): Promise<boolean> => {
      const result = await execa(
        "tmux",
        this.args("display-message", "-p", "-t", name, "#{pane_in_mode}"),
      );
      return result.stdout.trim() === "1";
    };
    if (lines > 0) {
      if (!(await inMode())) {
        await execa("tmux", this.args("copy-mode", "-t", name));
      }
      await execa(
        "tmux",
        this.args("send-keys", "-t", name, "-X", "-N", String(lines), "scroll-up"),
      );
      return;
    }
    if (!(await inMode())) return;
    await execa(
      "tmux",
      this.args("send-keys", "-t", name, "-X", "-N", String(-lines), "scroll-down"),
    );
    const position = await execa(
      "tmux",
      this.args("display-message", "-p", "-t", name, "#{scroll_position}"),
    );
    if (position.stdout.trim() === "0") {
      await execa("tmux", this.args("send-keys", "-t", name, "-X", "cancel"));
    }
  }
}
