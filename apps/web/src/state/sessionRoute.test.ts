import { beforeEach, describe, expect, it, vi } from "vitest";

/** sessionRoute touches window.location.hash, history.replaceState and a
    hashchange listener. A hand-rolled window records all three. */
function installWindow(initialHash = ""): {
  hash: string;
  replaced: string[];
  listeners: Map<string, Array<() => void>>;
  fire: (type: string) => void;
} {
  const state = {
    hash: initialHash,
    replaced: [] as string[],
    listeners: new Map<string, Array<() => void>>(),
    fire(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener();
    },
  };
  const historyDouble = {
    replaceState: (_data: unknown, _unused: string, url: string) => {
      state.replaced.push(url);
      state.hash = url.startsWith("#") ? url : `#${url}`;
    },
  };
  const globals = globalThis as Record<string, unknown>;
  // sessionRoute calls history.replaceState bare, not through window.
  globals.history = historyDouble;
  globals.window = {
    location: {
      get hash() {
        return state.hash;
      },
      set hash(value: string) {
        state.hash = value;
      },
    },
    history: historyDouble,
    addEventListener: (type: string, listener: () => void) => {
      const list = state.listeners.get(type) ?? [];
      list.push(listener);
      state.listeners.set(type, list);
    },
    removeEventListener: (type: string, listener: () => void) => {
      const list = state.listeners.get(type) ?? [];
      state.listeners.set(
        type,
        list.filter((item) => item !== listener),
      );
    },
  };
  return state;
}

const { useUi } = await import("./store");
const { initSessionRoute } = await import("./sessionRoute");

beforeEach(() => {
  useUi.setState({ selectedSessionId: null, openDiff: null });
});

describe("reading the hash on start", () => {
  it("selects the session a shared link points at", () => {
    installWindow("#/session/abc");
    initSessionRoute();
    expect(useUi.getState().selectedSessionId).toBe("abc");
  });

  it("decodes a percent-encoded id", () => {
    installWindow(`#/session/${encodeURIComponent("a b/c")}`);
    initSessionRoute();
    expect(useUi.getState().selectedSessionId).toBe("a b/c");
  });

  it("ignores a hash that is not a session link", () => {
    installWindow("#/");
    initSessionRoute();
    expect(useUi.getState().selectedSessionId).toBeNull();
  });

  it("treats an empty id as nothing selected", () => {
    installWindow("#/session/");
    initSessionRoute();
    expect(useUi.getState().selectedSessionId).toBeNull();
  });
});

describe("projecting the selection into the URL", () => {
  it("writes the hash on a selection change", () => {
    const win = installWindow();
    initSessionRoute();
    useUi.getState().selectSession("s1");
    expect(win.replaced).toEqual(["#/session/s1"]);
    expect(win.hash).toBe("#/session/s1");
  });

  it("writes a bare hash when the selection is cleared", () => {
    const win = installWindow("#/session/s1");
    initSessionRoute();
    useUi.getState().selectSession("s1");
    useUi.getState().selectSession(null);
    expect(win.replaced[win.replaced.length - 1]).toBe("#/");
  });

  it("does not rewrite the hash when the id did not change", () => {
    const win = installWindow("#/session/s1");
    initSessionRoute();
    useUi.getState().selectSession("s1");
    const afterInit = win.replaced.length;
    // selectSession always clears openDiff (it belongs to the old cwd), so
    // assert only the URL: a same-id selection must not touch replaceState.
    useUi.getState().selectSession("s1");
    expect(win.replaced.length).toBe(afterInit);
  });
});

describe("a shared link pasted into the open tab", () => {
  it("selects the id the hash now carries", () => {
    const win = installWindow("#/session/s1");
    initSessionRoute();
    win.hash = "#/session/s2";
    win.fire("hashchange");
    expect(useUi.getState().selectedSessionId).toBe("s2");
  });

  it("ignores a hashchange that agrees with the current selection", () => {
    const win = installWindow("#/session/s1");
    initSessionRoute();
    useUi.getState().setOpenDiff({ path: "a.ts", staged: false, letter: "M" });
    win.fire("hashchange"); // still #/session/s1
    expect(useUi.getState().selectedSessionId).toBe("s1");
    // The identity guard keeps openDiff alive.
    expect(useUi.getState().openDiff).not.toBeNull();
  });

  it("clears the selection when the hash stops naming a session", () => {
    const win = installWindow("#/session/s1");
    initSessionRoute();
    win.hash = "#/";
    win.fire("hashchange");
    expect(useUi.getState().selectedSessionId).toBeNull();
  });
});

describe("subscribe is not leaked", () => {
  it("registers exactly one hashchange listener per init", () => {
    const win = installWindow();
    initSessionRoute();
    expect((win.listeners.get("hashchange") ?? []).length).toBe(1);
  });
});

// vi is imported for the stub helpers above; keep the reference honest.
void vi;
