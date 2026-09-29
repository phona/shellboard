import { execa } from "execa";
import { afterAllCleanup, createServices, makeTempDir, sleep } from "./helpers";

afterAllCleanup();

describe("TmuxService (real tmux on dedicated socket)", () => {
  it("creates, lists, and kills sessions", async () => {
    const services = await createServices();
    const dir = makeTempDir();
    const name = `tm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    expect(await services.tmux.sessionExists(name)).toBe(false);
    await services.tmux.newSession(name, dir, ["bash"]);
    expect(await services.tmux.sessionExists(name)).toBe(true);

    const list = await services.tmux.listSessions();
    expect(list.has(name)).toBe(true);
    // window_activity is epoch seconds, converted to age by the service —
    // a just-created session must read as freshly active, not idle
    const age = list.get(name)?.activitySeconds;
    expect(age).not.toBeNull();
    expect(age).toBeLessThan(60);

    await services.tmux.killSession(name);
    expect(await services.tmux.sessionExists(name)).toBe(false);
  });

  it("applies session options: mouse off, clipboard via OSC 52", async () => {
    const services = await createServices();
    const dir = makeTempDir();
    const name = `opt-${Date.now()}`;
    await services.tmux.newSession(name, dir, ["bash"]);

    const show = async (option: string): Promise<string> => {
      const result = await execa(
        "tmux",
        ["-L", services.config.tmuxSocket, "show-options", "-v", "-t", name, option],
        { reject: false },
      );
      return result.stdout.trim();
    };
    const pane = async (format: string): Promise<string> => {
      const result = await execa(
        "tmux",
        ["-L", services.config.tmuxSocket, "display-message", "-p", "-t", name, format],
        { reject: false },
      );
      return result.stdout.trim();
    };
    // mouse off keeps selection native in the browser; the web client
    // scrolls its local mirror; the status line is dead weight in the web
    // UI; generous history-limit serves real `tmux attach` users
    expect(await show("mouse")).toBe("off");
    expect(await show("status")).toBe("off");
    // Web-first sizing: the pane follows the web client only through
    // explicit resize-window calls, never the last-active tmux client.
    expect(await show("window-size")).toBe("manual");
    // history-limit is a window option set globally before the pane exists
    // (newSession), so read the pane's effective value, not a session option
    expect(await pane("#{history_limit}")).toBe("50000");
    expect(await show("set-clipboard")).toBe("on");
    const overrides = await show("terminal-overrides");
    expect(overrides).toContain("Ms=");
    // D7: without these, tmux wraps the pane in the alternate screen and
    // scrolls updates with discarding CSI-S — the web client could never
    // accumulate scrollback. Capability names are terminfo lowercase.
    expect(overrides).toContain("smcup@");
    expect(overrides).toContain("rmcup@");
    expect(overrides).toContain("indn@");

    // The limit must be in effect when the pane is CREATED: set afterwards
    // it leaves the pane at tmux's 2000-line default (discarded lines never
    // come back). Prove it with more than 2000 lines of real output.
    await execa(
      "tmux",
      [
        "-L",
        services.config.tmuxSocket,
        "send-keys",
        "-t",
        name,
        "for i in $(seq 1 2500); do echo h$i; done",
        "Enter",
      ],
      { reject: false },
    );
    let historySize = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = await execa(
        "tmux",
        [
          "-L",
          services.config.tmuxSocket,
          "display-message",
          "-p",
          "-t",
          name,
          "#{history_size}",
        ],
        { reject: false },
      );
      historySize = Number(probe.stdout.trim());
      if (historySize > 2100) break;
      await sleep(100);
    }
    expect(historySize).toBeGreaterThan(2100);

    await services.tmux.killSession(name);
  });

  it("is fully isolated from the user's default tmux server (D2)", async () => {
    const services = await createServices();
    const dir = makeTempDir();
    const name = `iso-${Date.now()}`;
    await services.tmux.newSession(name, dir, ["bash"]);

    const result = await execa("tmux", ["list-sessions", "-F", "#{session_name}"], {
      reject: false,
    });
    const defaultServerSessions = result.failed ? "" : result.stdout;
    expect(defaultServerSessions).not.toContain(name);

    await services.tmux.killSession(name);
  });

  it("resizes the window on request and restores to the largest client", async () => {
    const services = await createServices();
    const dir = makeTempDir();
    const name = `wsz-${Date.now()}`;
    await services.tmux.newSession(name, dir, ["bash"]);

    const size = async (): Promise<string> => {
      const r = await execa(
        "tmux",
        [
          "-L",
          services.config.tmuxSocket,
          "display-message",
          "-p",
          "-t",
          name,
          "#{window_width}x#{window_height}",
        ],
        { reject: false },
      );
      return r.stdout.trim();
    };

    // The web client's geometry drives the pane (window-size manual).
    await services.tmux.resizeWindow(name, 166, 42);
    expect(await size()).toBe("166x42");
    await services.tmux.resizeWindow(name, 90, 30);
    expect(await size()).toBe("90x30");

    // With no clients left, restoreWindowSize is a no-op (size unchanged).
    await services.tmux.restoreWindowSize(name);
    expect(await size()).toBe("90x30");

    await services.tmux.killSession(name);
  });
});
