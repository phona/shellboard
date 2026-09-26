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
   * - mouse: wheel scrolling goes to tmux (copy-mode scroll) instead of the
   *   alternate-scroll fallback, which sends arrow keys to the inner shell.
   * - set-clipboard: releasing a mouse selection also pushes the outer
   *   clipboard via OSC 52 (xterm.js handles it → navigator.clipboard).
   */
  async applySessionOptions(name: string): Promise<void> {
    await execa("tmux", this.args("set-option", "-t", name, "monitor-activity", "on"));
    await execa("tmux", this.args("set-option", "-t", name, "mouse", "on"));
    await execa("tmux", this.args("set-option", "-t", name, "set-clipboard", "on"));
    // Many distros ship xterm-256color terminfo without the Ms (set
    // clipboard) capability, which silently disables set-clipboard — tmux
    // never emits OSC 52 and drag-selection never reaches the browser
    // clipboard. Assert it explicitly.
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
    // tmux ≥ 3.4 binds right-click to its own popup menu; the browser layer
    // owns right-click (paste). Key bindings are server-global, but this
    // socket is ours alone (D2).
    await execa("tmux", this.args("unbind-key", "-n", "MouseDown3Pane"), {
      reject: false,
    });
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
}
