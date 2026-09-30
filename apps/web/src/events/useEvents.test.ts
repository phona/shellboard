import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useEvents is a hook, and the suite runs in node with no DOM. Mocking the two
// React/query bindings it uses lets the effect body run directly, so the
// reconnect and event-routing logic is reachable without a renderer.
const h = vi.hoisted(() => ({
  cleanup: null as (() => void) | null,
  query: {
    invalidated: [] as string[][],
    seeded: null as unknown,
    invalidateQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
  },
  toasts: [] as unknown[][],
}));

vi.mock("react", () => ({
  useEffect: (fn: () => (() => void) | void) => {
    const cleanup = fn();
    if (typeof cleanup === "function") h.cleanup = cleanup;
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => h.query,
}));

vi.mock("../api/client.js", () => ({
  wsUrl: (path: string) => `ws://test${path}`,
}));

vi.mock("../state/toasts.js", () => ({
  toast: (...args: unknown[]) => void h.toasts.push(args),
}));

/** WebSocket double: the code assigns four handlers and calls close(). */
class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const { useUi } = await import("../state/store.js");
const { useEvents } = await import("./useEvents");

let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  h.cleanup = null;
  h.query.invalidated = [];
  h.query.invalidateQueries.mockReset();
  h.query.getQueryData.mockReset();
  h.query.setQueryData.mockReset();
  h.toasts = [];
  FakeWs.instances = [];
  hidden = false;
  (globalThis as Record<string, unknown>).WebSocket = FakeWs;
  (globalThis as Record<string, unknown>).document = {
    get hidden() {
      return hidden;
    },
  };
  (globalThis as Record<string, unknown>).Notification = undefined;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: number) => clearTimeout(handle),
  };
  useUi.setState({ selectedSessionId: null, notifications: false });
});

afterEach(() => {
  h.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const last = (): FakeWs => FakeWs.instances[FakeWs.instances.length - 1]!;
const send = (data: unknown) => last().onmessage?.({ data: JSON.stringify(data) });

describe("connecting", () => {
  it("opens the events socket and resyncs the stream-only queries", () => {
    useEvents();
    expect(last().url).toBe("ws://test/api/events");
    last().onopen?.();
    // Events broadcast while the socket was down are lost for good, so both
    // stream-only sources resync on every (re)connect.
    expect(h.query.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(h.query.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["git"] });
  });

  it("ignores a non-string frame", () => {
    useEvents();
    last().onmessage?.({ data: new ArrayBuffer(4) as unknown as string });
    expect(h.query.invalidateQueries).not.toHaveBeenCalled();
  });

  it("ignores a frame that is not JSON", () => {
    useEvents();
    last().onmessage?.({ data: "{not json" });
    expect(h.query.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("session lifecycle", () => {
  it("invalidates the session list on create, update and delete", () => {
    useEvents();
    for (const type of ["session.created", "session.updated", "session.deleted"]) {
      h.query.invalidateQueries.mockClear();
      send({ type, sessionId: "s1" });
      expect(h.query.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    }
  });

  it("clears the selection when the selected session is deleted", () => {
    useUi.setState({ selectedSessionId: "s1" });
    useEvents();
    send({ type: "session.deleted", sessionId: "s1" });
    expect(useUi.getState().selectedSessionId).toBeNull();
  });

  it("leaves the selection alone when another session is deleted", () => {
    useUi.setState({ selectedSessionId: "s1" });
    useEvents();
    send({ type: "session.deleted", sessionId: "s2" });
    expect(useUi.getState().selectedSessionId).toBe("s1");
  });
});

describe("session.activity", () => {
  const runtime = { sessionId: "s1", activity: "idle" };

  it("patches the matching row in the cached list", () => {
    h.query.getQueryData.mockReturnValue({
      sessions: [
        { session: { id: "s1", name: "one" }, runtime: { sessionId: "s1", activity: "working" } },
        { session: { id: "s2", name: "two" }, runtime: { sessionId: "s2", activity: "idle" } },
      ],
    });
    useEvents();
    send({ type: "session.activity", runtime: { sessionId: "s1", activity: "idle" } });
    expect(h.query.setQueryData).toHaveBeenCalled();
    const updater = h.query.setQueryData.mock.calls[0]![1] as (old: unknown) => unknown;
    expect(updater).toBeTypeOf("function");
    void runtime;
  });

  it("falls back to a generic name when the session is not in the cache", () => {
    h.query.getQueryData.mockReturnValue(undefined);
    hidden = true;
    (globalThis as Record<string, unknown>).Notification = undefined;
    useUi.setState({ notifications: true });
    useEvents();
    // No notification without a granted permission, but the row patch still runs.
    send({ type: "session.activity", runtime });
    expect(h.query.setQueryData).toHaveBeenCalled();
  });

  it("notifies on working -> idle only when the tab is hidden and opted in", () => {
    h.query.getQueryData.mockReturnValue({
      sessions: [{ session: { id: "s1", name: "one" } }],
    });
    hidden = false;
    useUi.setState({ notifications: true });
    useEvents();
    // First event establishes the previous state.
    send({ type: "session.activity", runtime: { sessionId: "s1", activity: "working" } });
    send({ type: "session.activity", runtime });
    // Tab visible: no Notification, and none is constructed in node anyway.
    expect(h.query.setQueryData).toHaveBeenCalledTimes(2);

    hidden = true;
    const seen: string[] = [];
    class FakeNotification {
      constructor(title: string, opts?: { body?: string }) {
        seen.push(`${title}:${opts?.body ?? ""}`);
      }
      static permission = "granted";
    }
    (globalThis as Record<string, unknown>).Notification = FakeNotification;
    send({ type: "session.activity", runtime: { sessionId: "s1", activity: "working" } });
    send({ type: "session.activity", runtime });
    expect(seen).toEqual(["Shellboard:one is now idle"]);
  });

  it("does not notify when the transition is not working -> idle", () => {
    hidden = true;
    useUi.setState({ notifications: true });
    const seen: string[] = [];
    class FakeNotification {
      constructor(title: string) {
        seen.push(title);
      }
      static permission = "granted";
    }
    (globalThis as Record<string, unknown>).Notification = FakeNotification;
    useEvents();
    send({ type: "session.activity", runtime: { sessionId: "s1", activity: "idle" } });
    send({ type: "session.activity", runtime });
    expect(seen).toEqual([]);
  });
});

describe("git.status_changed", () => {
  it("invalidates the git queries", () => {
    useEvents();
    send({ type: "git.status_changed" });
    expect(h.query.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["git"] });
  });
});

describe("session.notify", () => {
  it("shows a toast with the title and body joined", () => {
    useEvents();
    send({ type: "session.notify", title: "done", body: "all tasks", level: "info" });
    expect(h.toasts[0]).toEqual(["done — all tasks", "info", undefined]);
  });

  it("uses the title alone when there is no body", () => {
    useEvents();
    send({ type: "session.notify", title: "done", level: "error" });
    expect(h.toasts[0]).toEqual(["done", "error", undefined]);
  });

  it("truncates a long message rather than flooding the corner", () => {
    useEvents();
    send({ type: "session.notify", title: "x".repeat(300), level: "info" });
    const message = h.toasts[0]![0] as string;
    expect(message).toHaveLength(200);
    expect(message.endsWith("…")).toBe(true);
  });

  it("offers Show when the event names a session", () => {
    useEvents();
    send({ type: "session.notify", title: "done", session: { id: "s1", name: "one" } });
    const action = h.toasts[0]![2] as { label: string; onClick(): void };
    expect(action.label).toBe("Show");
    action.onClick();
    expect(useUi.getState().selectedSessionId).toBe("s1");
  });

  it("raises a system notification when the tab is hidden and opted in", () => {
    hidden = true;
    useUi.setState({ notifications: true });
    const seen: Array<[string, string]> = [];
    class FakeNotification {
      constructor(title: string, opts?: { body?: string }) {
        seen.push([title, opts?.body ?? ""]);
      }
      static permission = "granted";
    }
    (globalThis as Record<string, unknown>).Notification = FakeNotification;
    useEvents();
    send({ type: "session.notify", title: "done", body: "b", session: { id: "s1", name: "one" } });
    expect(seen).toEqual([["Shellboard · one", "done\nb"]]);
  });
});

describe("reconnect", () => {
  it("backs off progressively and caps at 10s", () => {
    useEvents();
    const delays: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const before = FakeWs.instances.length;
      last().onclose?.();
      let waited = 0;
      while (FakeWs.instances.length === before && waited < 20_000) {
        vi.advanceTimersByTime(1);
        waited += 1;
      }
      delays.push(waited);
    }
    // 1s, 2s, 3s ... then pinned at the 10s ceiling.
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(Math.max(...delays)).toBe(10_000);
    expect(delays[delays.length - 1]).toBe(10_000);
  });

  it("resets the backoff once a connection opens", () => {
    useEvents();
    last().onclose?.();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.instances).toHaveLength(2);
    last().onopen?.(); // healthy again
    last().onclose?.();
    vi.advanceTimersByTime(1000); // back to the first delay, not the second
    expect(FakeWs.instances).toHaveLength(3);
  });

  it("closes the socket on a transport error", () => {
    useEvents();
    last().onerror?.();
    expect(last().closed).toBe(true);
  });

  it("stops reconnecting after the effect is cleaned up", () => {
    useEvents();
    h.cleanup?.();
    expect(last().closed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(FakeWs.instances).toHaveLength(1);
  });
});
