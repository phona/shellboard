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

  it("applies mouse, clipboard, and right-click options to new sessions", async () => {
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
    expect(await show("mouse")).toBe("on");
    expect(await show("set-clipboard")).toBe("on");

    // tmux ≥ 3.4's default right-click menu must be gone (browser owns it)
    const bindings = await execa(
      "tmux",
      ["-L", services.config.tmuxSocket, "list-keys", "-n", "MouseDown3Pane"],
      { reject: false },
    );
    expect(bindings.stdout).not.toContain("MouseDown3Pane");

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
