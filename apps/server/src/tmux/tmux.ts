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
      {
        reject: false,
        // A hung tmux (blocked server, stuck client socket) must not stall
        // the observer: without a timeout this await never settles, the
        // observer's `ticking` latch stays set, and activity/exited stop
        // updating for the lifetime of the process.
        timeout: 5000,
      },
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
    // One invocation, three commands: boot the server (no-op if running),
    // raise the global history-limit, then create the session. history-limit
    // is a window option read when the pane is created — setting it after
    // new-session (the old order) leaves the pane at tmux's 2000-line
    // default forever, since already-discarded lines never come back, which
    // silently caps both the D5 scrollback and the D7 seed. Splitting these
    // into separate execa calls races a just-booted server ("no server
    // running"), hence the single command line.
    await execa(
      "tmux",
      this.args(
        "-f",
        "/dev/null",
        "start-server",
        ";",
        "set-option",
        "-g",
        "history-limit",
        "50000",
        ";",
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        ...command,
      ),
    );
    try {
      await this.applySessionOptions(name);
    } catch (err) {
      // The session exists but is unconfigured and unknown to the DB: an
      // orphan agent on the shellboard socket that nothing can list, kill,
      // or observe, and that blocks the tmuxName on retry. Kill it and let
      // the caller report the failure.
      await this.killSession(name);
      throw err;
    }
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
    await execa("tmux", this.args("set-option", "-t", name, "status", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "mouse", "off"));
    await execa("tmux", this.args("set-option", "-t", name, "set-clipboard", "on"));
    // Web-first sizing: with the default `latest`, the pane follows the
    // most recently active tmux client, so a plain terminal attached to
    // the same session keeps stealing the window size from the browser
    // (every steal = SIGWINCH = the agent TUI repaints its whole
    // transcript, permanent under the no-alt-screen setup). `manual` pins
    // the window to the size the web client asks for; see resizeWindow.
    await execa("tmux", this.args("set-option", "-t", name, "window-size", "manual"));
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

  /** Explicit window resize — the only way the pane changes size under
      `window-size manual`. Called with the web client's geometry so the
      browser terminal drives the pane. Failures are non-fatal: the pane
      keeps its size and the next frame re-asserts. */
  async resizeWindow(name: string, cols: number, rows: number): Promise<void> {
    await execa(
      "tmux",
      this.args("resize-window", "-t", name, "-x", String(cols), "-y", String(rows)),
      { reject: false },
    );
  }

  /** Hands the window size back to the largest remaining tmux client (a
      plain terminal), so a browser disconnect does not leave the pane
      pinned to the browser's geometry. No-op when no client remains. */
  async restoreWindowSize(name: string): Promise<void> {
    const result = await execa(
      "tmux",
      this.args("list-clients", "-t", name, "-F", "#{client_width} #{client_height}"),
      { reject: false },
    );
    if (result.failed) return;
    let best: { cols: number; rows: number } | null = null;
    for (const line of result.stdout.split("\n")) {
      const [cols, rows] = line.trim().split(/\s+/).map(Number);
      if (cols === undefined || rows === undefined) continue;
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) continue;
      if (!best || cols * rows > best.cols * best.rows) {
        best = { cols, rows };
      }
    }
    if (best) await this.resizeWindow(name, best.cols, best.rows);
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
    // Defense in depth for D6: the payload is typed literally (send-keys
    // -l), so a newline byte would be a line submit and the pane would
    // execute the text's first line. Names are sanitized upstream; this is
    // the last gate before the pane.
    if (/[\n\r]/.test(text)) {
      throw httpError(400, "refusing to send text containing a newline");
    }
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
