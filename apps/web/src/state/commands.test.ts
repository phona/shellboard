import { beforeEach, describe, expect, it } from "vitest";
import type { Command } from "@shellboard/contracts";
import {
  LOCAL_COMMANDS_KEY,
  discardLocalPresets,
  planMigration,
  readLocalPresets,
} from "./commandsMigration";

function command(name: string): Command {
  return { id: `c_${name}`, name, command: "echo hi", env: {}, createdAt: "now" };
}

describe("localStorage migration", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => [...stored.keys()][index] ?? null,
    length: 0,
  };

  beforeEach(() => {
    stored.clear();
  });

  it("reads the pre-D9 zustand-persisted shape", () => {
    stored.set(
      LOCAL_COMMANDS_KEY,
      JSON.stringify([
        { name: "dev", command: "pnpm dev" },
        { name: "", command: "ignored" },
        { command: "no name" },
        "garbage",
      ]),
    );
    expect(readLocalPresets(storage as unknown as Storage)).toEqual([
      { name: "dev", command: "pnpm dev" },
    ]);
  });

  it("reads nothing from absent or corrupt storage", () => {
    expect(readLocalPresets(storage as unknown as Storage)).toEqual([]);
    stored.set(LOCAL_COMMANDS_KEY, "{not json");
    expect(readLocalPresets(storage as unknown as Storage)).toEqual([]);
    stored.set(LOCAL_COMMANDS_KEY, JSON.stringify({ name: "dev" }));
    expect(readLocalPresets(storage as unknown as Storage)).toEqual([]);
  });

  it("skips names the server already has", () => {
    const remote = [command("dev")];
    expect(planMigration(remote, [{ name: "dev", command: "pnpm dev" }])).toEqual([]);
    expect(
      planMigration(remote, [
        { name: "dev", command: "pnpm dev" },
        { name: "test", command: "pnpm test" },
      ]),
    ).toEqual([{ name: "test", command: "pnpm test" }]);
  });

  it("clears the local copy and arms the guard", () => {
    stored.set(LOCAL_COMMANDS_KEY, JSON.stringify([{ name: "dev", command: "pnpm dev" }]));
    discardLocalPresets(storage as unknown as Storage);
    expect(stored.has(LOCAL_COMMANDS_KEY)).toBe(false);
    expect(stored.get("shellboard.commands.migrated")).toBe("1");
  });
});
