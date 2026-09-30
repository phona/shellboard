import { beforeEach, describe, expect, it } from "vitest";

/** zustand's persist middleware reads and writes localStorage on every set,
    which does not exist in node. Back it with a Map so the tests can also
    assert what actually gets persisted. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    },
  };
  const globals = globalThis as Record<string, unknown>;
  // zustand v5's persist defaults to window.localStorage, not the bare global,
  // so both have to exist or it silently disables persistence altogether.
  globals.localStorage = storage;
  globals.window = { localStorage: storage };
  return backing;
}

/** Installed before the store is imported: zustand's persist hydrates from
    localStorage while the module is being created, so the stub has to exist
    by then or it silently falls back to a no-op storage. */
const persisted = installStorage();

const { useUi } = await import("./store");

beforeEach(() => {
  persisted.clear();
  useUi.setState({
    selectedSessionId: null,
    openDiff: null,
    rightTab: "diff",
    leftCollapsed: false,
    rightCollapsed: false,
    toolMaximized: false,
    mobilePanel: "none",
    leftWidth: 240,
    rightWidth: 420,
    fontSize: 13,
    scrollback: 5000,
    notifications: false,
    authRequired: false,
    searchQuery: "",
  });
});

const ui = () => useUi.getState();

describe("defaults", () => {
  it("starts with nothing selected and the diff tab open", () => {
    expect(ui().selectedSessionId).toBeNull();
    expect(ui().openDiff).toBeNull();
    expect(ui().rightTab).toBe("diff");
    expect(ui().mobilePanel).toBe("none");
  });
});

describe("selectSession", () => {
  it("clears the open diff — it belongs to the previous session's cwd", () => {
    ui().setOpenDiff({ path: "a.ts", staged: false, letter: "M" });
    ui().selectSession("s2");
    expect(ui().selectedSessionId).toBe("s2");
    expect(ui().openDiff).toBeNull();
  });

  it("accepts null, for a session that was killed", () => {
    ui().selectSession("s1");
    ui().selectSession(null);
    expect(ui().selectedSessionId).toBeNull();
  });
});

describe("collapses and tabs", () => {
  it("toggles each side independently", () => {
    ui().toggleLeft();
    expect(ui().leftCollapsed).toBe(true);
    expect(ui().rightCollapsed).toBe(false);
    ui().toggleRight();
    expect(ui().rightCollapsed).toBe(true);
    ui().toggleLeft();
    expect(ui().leftCollapsed).toBe(false);
  });

  it("sets the right tab", () => {
    ui().setRightTab("files");
    expect(ui().rightTab).toBe("files");
    ui().setRightTab("term");
    expect(ui().rightTab).toBe("term");
  });

  it("sets the mobile panel", () => {
    ui().setMobilePanel("tools");
    expect(ui().mobilePanel).toBe("tools");
  });
});

describe("clamps", () => {
  it("keeps the left pane within 160-600", () => {
    ui().setLeftWidth(10);
    expect(ui().leftWidth).toBe(160);
    ui().setLeftWidth(9999);
    expect(ui().leftWidth).toBe(600);
    ui().setLeftWidth(300);
    expect(ui().leftWidth).toBe(300);
  });

  it("keeps the right pane within 240-900", () => {
    ui().setRightWidth(1);
    expect(ui().rightWidth).toBe(240);
    ui().setRightWidth(9999);
    expect(ui().rightWidth).toBe(900);
  });

  it("keeps the font size within 9-24", () => {
    ui().setFontSize(1);
    expect(ui().fontSize).toBe(9);
    ui().setFontSize(99);
    expect(ui().fontSize).toBe(24);
  });

  it("does not clamp the scrollback — the server clamps it", () => {
    ui().setScrollback(1);
    expect(ui().scrollback).toBe(1);
    ui().setScrollback(999_999);
    expect(ui().scrollback).toBe(999_999);
  });
});

describe("searchQuery", () => {
  it("stores the raw text", () => {
    ui().setSearchQuery("abc");
    expect(ui().searchQuery).toBe("abc");
  });
});

describe("persistence", () => {
  // persist writes through a storage call that lands on a later tick.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("persists only the partialized fields", async () => {
    ui().setLeftWidth(300);
    await flush();
    ui().setSearchQuery("secret");
    ui().selectSession("s1");
    // persist wraps the partialized slice: { state, version }.
    const written = JSON.parse(persisted.get("shellboard.ui") ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(written.state?.leftWidth).toBe(300);
    expect(written.state?.scrollback).toBe(5000);
    // Per-session and transient state must not survive a reload.
    expect(written.state?.searchQuery).toBeUndefined();
    expect(written.state?.selectedSessionId).toBeUndefined();
    expect(written.state?.openDiff).toBeUndefined();
    expect(written.state?.authRequired).toBeUndefined();
    expect(written.state?.mobilePanel).toBeUndefined();
    expect(written.state?.toolMaximized).toBeUndefined();
  });

  it("persists a clamped width, not the requested one", async () => {
    ui().setLeftWidth(9999);
    await flush();
    const written = JSON.parse(persisted.get("shellboard.ui") ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(written.state?.leftWidth).toBe(600);
  });
});
