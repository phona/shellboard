import type { Command } from "@shellboard/contracts";

/**
 * One-time import of the browser-local presets that predate server-side
 * commands (D9). Before this change the registry lived in
 * `localStorage["shellboard.commands"]`; without the import every existing
 * preset would silently vanish on the first load.
 */
export const LOCAL_COMMANDS_KEY = "shellboard.commands";
const MIGRATION_GUARD_KEY = "shellboard.commands.migrated";

export interface LocalPreset {
  name: string;
  command: string;
}

/** Anything unreadable (wrong shape, corrupt JSON, another origin's data)
    reads as "nothing to import" rather than throwing on boot. */
export function readLocalPresets(storage: Storage | undefined = safeStorage()): LocalPreset[] {
  if (!storage) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(LOCAL_COMMANDS_KEY) ?? "null");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const presets: LocalPreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { name, command } = entry as { name?: unknown; command?: unknown };
    if (typeof name !== "string" || typeof command !== "string") continue;
    if (name.trim().length === 0 || command.trim().length === 0) continue;
    presets.push({ name, command });
  }
  return presets;
}

/**
 * Which stored presets are worth importing: names already on the server are
 * skipped (the server copy wins — it may carry env vars the local copy never
 * had), and an empty result means there is nothing to do.
 */
export function planMigration(remote: Command[], stored: LocalPreset[]): LocalPreset[] {
  const taken = new Set(remote.map((command) => command.name));
  return stored.filter((preset) => !taken.has(preset.name));
}

/** Called only after a successful import (or when nothing was importable), so
    a failed import leaves the local copy for the next page load. */
export function discardLocalPresets(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  storage.removeItem(LOCAL_COMMANDS_KEY);
  storage.setItem(MIGRATION_GUARD_KEY, "1");
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // Storage access throws in some privacy modes; migration is best-effort.
    return undefined;
  }
}
