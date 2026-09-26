import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RegisteredCommand {
  name: string;
  command: string;
}

interface CommandsState {
  commands: RegisteredCommand[];
  add(name: string, command: string): void;
  remove(name: string): void;
}

/**
 * User-registered launch commands (Settings), offered as one-click presets
 * in the new-session dialog. Browser-persisted; registering only curates
 * presets — launching still goes through the server's validated custom
 * command path.
 */
export const useCommands = create<CommandsState>()(
  persist(
    (set) => ({
      commands: [],
      add: (name, command) =>
        set((state) => ({
          commands: [
            ...state.commands.filter((item) => item.name !== name),
            { name, command },
          ],
        })),
      remove: (name) =>
        set((state) => ({
          commands: state.commands.filter((item) => item.name !== name),
        })),
    }),
    { name: "shellboard.commands" },
  ),
);
