import { beforeEach, describe, expect, it } from "vitest";

/** zustand v5's persist defaults to window.localStorage; see store.test.ts for
    why both the bare global and window have to exist. */
const persisted = new Map<string, string>();
const storage = {
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => void persisted.set(key, value),
  removeItem: (key: string) => void persisted.delete(key),
  clear: () => persisted.clear(),
  key: (index: number) => [...persisted.keys()][index] ?? null,
  get length() {
    return persisted.size;
  },
};
(globalThis as Record<string, unknown>).localStorage = storage;
(globalThis as Record<string, unknown>).window = { localStorage: storage };

const { useCommands } = await import("./commands");
const commands = () => useCommands.getState().commands;

// The store is module scope, so every test starts from an empty preset list.
beforeEach(() => {
  useCommands.setState({ commands: [] });
});

describe("add", () => {
  it("appends a preset", () => {
    useCommands.getState().add("dev", "pnpm dev");
    expect(commands()).toEqual([{ name: "dev", command: "pnpm dev" }]);
  });

  it("replaces a preset with the same name rather than duplicating it", () => {
    useCommands.getState().add("dev", "pnpm dev");
    useCommands.getState().add("dev", "pnpm dev --host");
    expect(commands()).toEqual([{ name: "dev", command: "pnpm dev --host" }]);
  });

  it("keeps distinct names apart", () => {
    useCommands.getState().add("a", "1");
    useCommands.getState().add("b", "2");
    expect(commands().map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("remove", () => {
  it("drops only the named preset", () => {
    useCommands.getState().add("a", "1");
    useCommands.getState().add("b", "2");
    useCommands.getState().remove("a");
    expect(commands().map((c) => c.name)).toEqual(["b"]);
  });

  it("is a no-op for an unknown name", () => {
    useCommands.getState().add("a", "1");
    useCommands.getState().remove("zzz");
    expect(commands()).toHaveLength(1);
  });
});
