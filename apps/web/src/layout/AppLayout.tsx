import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { api } from "../api/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { DiffPanel } from "../features/git/DiffPanel";
import { FilesPanel } from "../features/files/FilesPanel";
import { TerminalView } from "../features/terminal/TerminalView";
import { getThemeMode, setThemeMode, type ThemeMode } from "../state/theme";
import { useUi, type RightTab } from "../state/store";
import { relativeTime } from "../util/format";
import { isTypingTarget, KEYBINDINGS, matchesBinding } from "../util/dom";
import { SettingsPopover } from "../settings/SettingsPopover";

const AGENT_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  gemini: "Gemini",
  shell: "Shell",
  custom: "Custom",
};

function useDrag(kind: "left" | "right") {
  return (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = useUi.getState().leftWidth;
    const startRight = useUi.getState().rightWidth;
    const move = (e: PointerEvent) => {
      const delta = e.clientX - startX;
      if (kind === "left") useUi.getState().setLeftWidth(startLeft + delta);
      else useUi.getState().setRightWidth(startRight - delta);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

const NEXT_THEME: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

function CycleThemeButton() {
  return (
    <button
      type="button"
      className="icon-btn"
      title="Toggle theme (System → Light → Dark)"
      onClick={() => setThemeMode(NEXT_THEME[getThemeMode()])}
    >
      ☀/☾
    </button>
  );
}

const TABS: ReadonlyArray<{ id: RightTab; label: string }> = [
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "term", label: "Term" },
];

export function AppLayout({ sidebar }: { sidebar: ReactNode }) {
  const selectedSessionId = useUi((state) => state.selectedSessionId);
  const rightTab = useUi((state) => state.rightTab);
  const leftCollapsed = useUi((state) => state.leftCollapsed);
  const rightCollapsed = useUi((state) => state.rightCollapsed);
  const leftWidth = useUi((state) => state.leftWidth);
  const rightWidth = useUi((state) => state.rightWidth);
  const searchQuery = useUi((state) => state.searchQuery);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: api.sessions.list,
    refetchInterval: 15000,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const selected = sessions.find((item) => item.session.id === selectedSessionId) ?? null;

  const statusQuery = useQuery({
    queryKey: ["git", "status", selectedSessionId],
    queryFn: () => api.git.status(selectedSessionId ?? ""),
    enabled: selectedSessionId !== null,
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      useUi.getState().selectSession(sessions[0]?.session.id ?? null);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (selectedSessionId && !selected && sessionsQuery.isSuccess) {
      useUi.getState().selectSession(null);
    }
  }, [selectedSessionId, selected, sessionsQuery.isSuccess]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (matchesBinding(event, KEYBINDINGS.search)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dragLeft = useDrag("left");
  const dragRight = useDrag("right");

  const working = sessions.filter((item) => item.runtime.activity === "working").length;
  const idle = sessions.filter(
    (item) => item.runtime.activity === "idle" || item.runtime.activity === "cooling",
  ).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▣</span> Shellboard
        </div>
        <input
          ref={searchRef}
          className="search"
          placeholder={`Search sessions  (${KEYBINDINGS.search})`}
          value={searchQuery}
          onChange={(event) => useUi.getState().setSearchQuery(event.target.value)}
        />
        <div className="topbar-actions">
          <CycleThemeButton />
          <SettingsPopover />
        </div>
      </header>

      <div className="main">
        <aside
          className={leftCollapsed ? "sidebar collapsed" : "sidebar"}
          style={{ width: leftWidth }}
        >
          {sidebar}
        </aside>
        {!leftCollapsed && <div className="gutter" onPointerDown={dragLeft} />}
        {leftCollapsed && (
          <button
            type="button"
            className="panel-reopen"
            title={`Show sessions (${KEYBINDINGS.toggleLeft})`}
            aria-label="Show sessions"
            onClick={() => useUi.getState().toggleLeft()}
          >
            »
          </button>
        )}

        <main className="center">
          {selected ? (
            <ErrorBoundary>
              <TerminalView key={selected.session.id} data={selected} variant="agent" />
            </ErrorBoundary>
          ) : (
            <div className="empty-center">
              <h1>Shellboard</h1>
              <div>Manage shells, not agents.</div>
              <div className="muted">
                Create a project and a session in the sidebar to start.
              </div>
            </div>
          )}
        </main>

        <aside className={rightCollapsed ? "toolview collapsed" : "toolview"} style={{ width: rightWidth }}>
          <div className="tool-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={rightTab === tab.id ? "tool-tab active" : "tool-tab"}
                onClick={() => useUi.getState().setRightTab(tab.id)}
              >
                {tab.label}
                {tab.id === "diff" && (statusQuery.data?.entries.length ?? 0) > 0 && (
                  <span className="badge">{statusQuery.data?.entries.length}</span>
                )}
              </button>
            ))}
            <span className="spacer" />
            <button
              type="button"
              className="icon-btn"
              title={`Collapse panel (${KEYBINDINGS.toggleRight})`}
              onClick={() => useUi.getState().toggleRight()}
            >
              »
            </button>
          </div>
          <div className="tool-body">
            {rightCollapsed ? null : selected ? (
              <ErrorBoundary>
                {rightTab === "diff" ? (
                  <DiffPanel data={selected} />
                ) : rightTab === "files" ? (
                  <FilesPanel data={selected} />
                ) : (
                  <TerminalView data={selected} variant="tool" />
                )}
              </ErrorBoundary>
            ) : (
              <div className="tool-placeholder">Select a session</div>
            )}
          </div>
        </aside>
        {!rightCollapsed && <div className="gutter" onPointerDown={dragRight} />}
        {rightCollapsed && (
          <button
            type="button"
            className="panel-reopen"
            title={`Show tool panel (${KEYBINDINGS.toggleRight})`}
            aria-label="Show tool panel"
            onClick={() => useUi.getState().toggleRight()}
          >
            «
          </button>
        )}
      </div>

      <footer className="statusbar">
        <span>{sessions.length} sessions</span>
        <span>
          <span className="dot">●</span> {working} working · {idle} idle
        </span>
        {selected && (
          <span>
            {selected.session.name} · {AGENT_LABEL[selected.session.agentType]} ·{" "}
            {relativeTime(selected.runtime.lastActivityAt)}
          </span>
        )}
        {statusQuery.data?.branch && <span className="muted">{statusQuery.data.branch}</span>}
        {(statusQuery.data?.entries.length ?? 0) > 0 && (
          <span>{statusQuery.data?.entries.length} changed files</span>
        )}
      </footer>
    </div>
  );
}
