import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightTab = "diff" | "files" | "term";
/** Which pane covers the screen on phones (see AppLayout mobile branch). */
export type MobilePanel = "none" | "sessions" | "tools";

/** File opened in the main workspace's DiffView (center swaps off the shell). */
export interface OpenDiff {
  path: string;
  staged: boolean;
  letter: string;
}

interface UiState {
  selectedSessionId: string | null;
  openDiff: OpenDiff | null;
  rightTab: RightTab;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toolMaximized: boolean;
  mobilePanel: MobilePanel;
  leftWidth: number;
  rightWidth: number;
  fontSize: number;
  scrollback: number;
  notifications: boolean;
  authRequired: boolean;
  searchQuery: string;
  selectSession(id: string | null): void;
  setOpenDiff(value: OpenDiff | null): void;
  setRightTab(tab: RightTab): void;
  toggleLeft(): void;
  toggleRight(): void;
  setToolMaximized(value: boolean): void;
  setMobilePanel(panel: MobilePanel): void;
  setLeftWidth(width: number): void;
  setRightWidth(width: number): void;
  setFontSize(px: number): void;
  setScrollback(lines: number): void;
  setNotifications(on: boolean): void;
  setAuthRequired(value: boolean): void;
  setSearchQuery(query: string): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
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
      // a session switch invalidates the opened diff — it belongs to the
      // previous session's cwd
      selectSession: (id) => set({ selectedSessionId: id, openDiff: null }),
      setOpenDiff: (value) => set({ openDiff: value }),
      setRightTab: (tab) => set({ rightTab: tab }),
      toggleLeft: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
      toggleRight: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),
      setToolMaximized: (value) => set({ toolMaximized: value }),
      setMobilePanel: (panel) => set({ mobilePanel: panel }),
      setLeftWidth: (width) => set({ leftWidth: clamp(width, 160, 600) }),
      setRightWidth: (width) => set({ rightWidth: clamp(width, 240, 900) }),
      setFontSize: (px) => set({ fontSize: clamp(px, 9, 24) }),
      setScrollback: (lines) => set({ scrollback: lines }),
      setNotifications: (on) => {
        set({ notifications: on });
        if (
          on &&
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        ) {
          void Notification.requestPermission();
        }
      },
      setAuthRequired: (value) => set({ authRequired: value }),
      setSearchQuery: (query) => set({ searchQuery: query }),
    }),
    {
      name: "shellboard.ui",
      partialize: (state) => ({
        rightTab: state.rightTab,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        leftWidth: state.leftWidth,
        rightWidth: state.rightWidth,
        fontSize: state.fontSize,
        scrollback: state.scrollback,
        notifications: state.notifications,
      }),
    },
  ),
);
