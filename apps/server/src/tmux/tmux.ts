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
   * Resolves a pane id (the TMUX_PANE value a process sees inside the pane)
   * to its tmux session name — how notify events from agent hooks are
   * attributed to a shellboard session (D8). A tmux state query, like
   * #{alternate_on} in D7; no terminal bytes involved.
   */
  async sessionNameForPane(paneId: string): Promise<string | null> {
    const result = await execa(
      "tmux",
      this.args("display-message", "-p", "-t", paneId, "#{session_name}"),
      { reject: false },
    );
    if (result.failed) return null;
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
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
   *   the web client scrolls its local buffer (D7) — no mouse reporting.
   * - set-clipboard + Ms override: tmux copy commands and inner CLIs still
   *   push to the browser clipboard via OSC 52.
   */
  async applySessionOptions(name: string): Promise<void> {
    await execa("tmux", this.args("set-option", "-t", name, "monitor-activity", "on"));
    // Generous scrollback for real `tmux attach` users.
    await execa("tmux", this.args("set-option", "-t", name, "history-limit", "50000"));
    await execa("tmux", this.args("set-option", "-t", name, "status", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "mouse", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "set-clipboard", "on"));
    // Many distros ship xterm-256color terminfo without the Ms (set
    // clipboard) capability, which silently disables set-clipboard — tmux
    // never emits OSC 52. Assert it explicitly. smcup/rmcup/indn are
    // removed (D7): the web terminal is a plain scrolling terminal without
    // an alternate screen. With smcup present, tmux wraps the pane in 1049;
    // and for pane scrolling it emits indn (CSI S, scroll-up), whose
    // semantics DISCARD the lines leaving the top — with either, the client
    // could never accumulate scrollback. Without them, tmux repaints pane
    // updates onto the normal screen and scrolls with plain LF at the
    // bottom margin, so the transcript accumulates in the web client's
    // local scrollback, and full-screen pane apps paint over the screen
    // without polluting it (their exit restores the transcript).
    // Capability names are terminfo lowercase — tmux's internal names
    // (Smcup/Rmcup) do not match in overrides.
    await execa(
      "tmux",
      this.args(
        "set-option",
        "-t",
        name,
        "terminal-overrides",
        "xterm*:Ms=\\E]52;%p1%s;%p2%s\\007,xterm*:smcup@,xterm*:rmcup@,xterm*:indn@",
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

  /** Forces the pane's application to repaint: one column narrower and back.
      A control-mode connection only sees bytes produced while subscribed, so
      the output tap fires this after every (re)connect — the repaint fills
      the mirror with the current screen (and any hole since a reconnect).
      Apps must handle resize to be usable at all, so this is safe; a
      momentary 1-column reflow is visible to a manually attached client. */
  async nudgeRepaint(name: string): Promise<void> {
    const probe = await execa(
      "tmux",
      this.args("display-message", "-p", "-t", name, "#{pane_width} #{pane_height}"),
      { reject: false },
    );
    if (probe.failed) return;
    const [w, h] = probe.stdout.trim().split(" ").map(Number);
    if (!w || !h || w <= 2) return;
    await execa("tmux", this.args("resize-pane", "-t", name, "-x", String(w - 1), "-y", String(h)), {
      reject: false,
    });
    await execa("tmux", this.args("resize-pane", "-t", name, "-x", String(w), "-y", String(h)), {
      reject: false,
    });
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


}
