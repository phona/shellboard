import { beforeEach, describe, expect, it, vi } from "vitest";

/** theme reads CSS custom properties off documentElement and watches the
    system colour scheme. Both are stubbed with recording doubles. */
function installDom(vars: Record<string, string> = {}) {
  const dataset: Record<string, string> = {};
  const listeners = new Map<string, Array<() => void>>();
  const dispatched: string[] = [];
  const mediaListeners = new Map<string, Array<() => void>>();
  (globalThis as Record<string, unknown>).document = {
    documentElement: { dataset },
  };
  (globalThis as Record<string, unknown>).getComputedStyle = () => ({
    getPropertyValue: (name: string) => vars[name] ?? "",
  });
  (globalThis as Record<string, unknown>).window = {
    dispatchEvent: (event: { type: string }) => {
      dispatched.push(event.type);
      for (const listener of listeners.get(event.type) ?? []) listener();
    },
    addEventListener: (type: string, listener: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, listener: () => void) => {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((item) => item !== listener),
      );
    },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? darkMatches : false,
      addEventListener: (type: string, listener: () => void) => {
        const list = mediaListeners.get(type) ?? [];
        list.push(listener);
        mediaListeners.set(type, list);
      },
    }),
  };
  return {
    dataset,
    listeners,
    dispatched,
    fireThemeEvent: () => {
      for (const listener of listeners.get("sb-theme-change") ?? []) listener();
    },
    fireMediaChange: () => {
      for (const listener of mediaListeners.get("change") ?? []) listener();
    },
  };
}

let darkMatches = false;

const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
};

const theme = await import("./theme");

beforeEach(() => {
  backing.clear();
  darkMatches = false;
  installDom();
});

describe("getThemeMode", () => {
  it("defaults to system when nothing is stored", () => {
    expect(theme.getThemeMode()).toBe("system");
  });

  it("reads back an explicit choice", () => {
    backing.set("shellboard.theme", "dark");
    expect(theme.getThemeMode()).toBe("dark");
    backing.set("shellboard.theme", "light");
    expect(theme.getThemeMode()).toBe("light");
  });

  it("falls back to system for a value it does not know", () => {
    backing.set("shellboard.theme", "solarized");
    expect(theme.getThemeMode()).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("returns an explicit mode as written", () => {
    expect(theme.resolveTheme("light")).toBe("light");
    expect(theme.resolveTheme("dark")).toBe("dark");
  });

  it("asks the system when the mode is system", () => {
    installDom();
    darkMatches = true;
    expect(theme.resolveTheme("system")).toBe("dark");
    darkMatches = false;
    expect(theme.resolveTheme("system")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes the resolved theme onto documentElement", () => {
    const dom = installDom();
    backing.set("shellboard.theme", "light");
    theme.applyTheme();
    expect(dom.dataset.theme).toBe("light");
  });

  it("announces the change so subscribers re-read", () => {
    const dom = installDom();
    theme.applyTheme();
    expect(dom.dispatched).toContain("sb-theme-change");
  });
});

describe("setThemeMode", () => {
  it("stores the choice and applies it", () => {
    const dom = installDom();
    theme.setThemeMode("dark");
    expect(backing.get("shellboard.theme")).toBe("dark");
    expect(dom.dataset.theme).toBe("dark");
  });
});

describe("initTheme", () => {
  it("applies immediately and follows the system while in system mode", () => {
    const dom = installDom();
    theme.initTheme();
    expect(dom.dataset.theme).toBe("light"); // system + light OS
    darkMatches = true;
    dom.fireMediaChange();
    expect(dom.dataset.theme).toBe("dark");
  });

  it("stays put when the user chose explicitly", () => {
    const dom = installDom();
    backing.set("shellboard.theme", "light");
    theme.initTheme();
    darkMatches = true;
    dom.fireMediaChange();
    expect(dom.dataset.theme).toBe("light");
  });
});

describe("subscribeTheme", () => {
  it("calls back on a theme change and stops after unsubscribe", () => {
    const seen: number[] = [];
    const unsubscribe = theme.subscribeTheme(() => seen.push(1));
    theme.setThemeMode("dark");
    expect(seen).toHaveLength(1);
    unsubscribe();
    theme.setThemeMode("light");
    expect(seen).toHaveLength(1);
  });
});

describe("readTerminalTheme", () => {
  it("reads each custom property", () => {
    installDom({
      "--term-bg": "#000000",
      "--term-fg": "#ffffff",
      "--term-cursor": "#ff0000",
      "--term-selection": "#123456",
      "--term-search-match": "#111111",
      "--term-search-active": "#222222",
    });
    expect(theme.readTerminalTheme()).toEqual({
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ff0000",
      // cursorAccent reuses the background so the block stays readable
      cursorAccent: "#000000",
      selectionBackground: "#123456",
      searchMatch: "#111111",
      searchActive: "#222222",
    });
  });

  it("falls back per property when the stylesheet is missing", () => {
    installDom();
    const read = theme.readTerminalTheme();
    expect(read.background).toBe("#0d1117");
    expect(read.foreground).toBe("#e6edf3");
    expect(read.cursor).toBe("#e6edf3");
    expect(read.selectionBackground).toBe("rgba(9, 105, 218, 0.35)");
  });
});

describe("readMonoFontStack", () => {
  it("reads the stack from theme.css", () => {
    installDom({ "--mono": "JetBrains Mono, monospace" });
    expect(theme.readMonoFontStack()).toBe("JetBrains Mono, monospace");
  });

  it("falls back when the variable is empty", () => {
    installDom();
    expect(theme.readMonoFontStack()).toContain("ui-monospace");
  });
});

void vi;
