import { execa } from "execa";
import { afterAllCleanup, createServices, makeTempDir } from "./helpers";

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
    expect(list.get(name)?.activitySeconds).not.toBeNull();

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
    // mouse off keeps selection native in the browser; scrolling goes
    // through the server-side scroll channel; the status line is dead
    // weight in the web UI
    expect(await show("mouse")).toBe("off");
    expect(await show("status")).toBe("off");
    expect(await show("set-clipboard")).toBe("on");
    const overrides = await show("terminal-overrides");
    expect(overrides).toContain("Ms=");

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
});
