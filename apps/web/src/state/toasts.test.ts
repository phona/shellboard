import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useToasts reads the module-private array through useSyncExternalStore.
// Mocking that one binding lets the test observe the array without a
// renderer — the suite runs in node with no DOM.
vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const { dismiss, toast, useToasts } = await import("./toasts");

const current = (): ReadonlyArray<{ id: number; message: string; kind: string; action?: unknown }> =>
  useToasts() as ReturnType<typeof useToasts>;

beforeEach(() => {
  vi.useFakeTimers();
  // toasts.ts schedules through window.setTimeout. Delegating to the global
  // means the fake timers installed above are what it actually calls.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
  for (const item of current()) dismiss(item.id);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toast", () => {
  it("adds a toast with its kind", () => {
    toast("saved", "info");
    toast("broken", "error");
    expect(current().map((t) => [t.message, t.kind])).toEqual([
      ["saved", "info"],
      ["broken", "error"],
    ]);
  });

  it("defaults to the info kind", () => {
    toast("plain");
    expect(current()[0]!.kind).toBe("info");
  });

  it("caps the stack at four, newest wins", () => {
    // A failed batch must not flood the corner.
    for (let i = 1; i <= 7; i += 1) toast(`m${i}`);
    expect(current().map((t) => t.message)).toEqual(["m4", "m5", "m6", "m7"]);
  });

  it("auto-dismisses a plain toast after 4s", () => {
    toast("plain");
    expect(current()).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    expect(current()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(current()).toHaveLength(0);
  });

  it("gives an actionable toast longer to click", () => {
    toast("uploaded", "info", { label: "Send", onClick: () => {} });
    vi.advanceTimersByTime(7999);
    expect(current()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(current()).toHaveLength(0);
  });
});

describe("dismiss", () => {
  it("removes only the named toast", () => {
    toast("a");
    toast("b");
    const [first] = current();
    dismiss(first!.id);
    expect(current().map((t) => t.message)).toEqual(["b"]);
  });

  it("ignores an unknown id", () => {
    toast("a");
    dismiss(9999);
    expect(current()).toHaveLength(1);
  });
});
