import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { DiffPanel } from "../features/git/DiffPanel";
import { DiffView } from "../features/git/DiffView";
import { FilesPanel } from "../features/files/FilesPanel";
import { TerminalView } from "../features/terminal/TerminalView";
import { getThemeMode, setThemeMode, type ThemeMode } from "../state/theme";
import { useUi, type RightTab } from "../state/store";
import { relativeTime } from "../util/format";
import { isTypingTarget, KEYBINDINGS, matchesBinding } from "../util/dom";
import { useMediaQuery } from "../util/useMediaQuery";
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
  const openDiff = useUi((state) => state.openDiff);
  const rightTab = useUi((state) => state.rightTab);
  const leftCollapsed = useUi((state) => state.leftCollapsed);
  const rightCollapsed = useUi((state) => state.rightCollapsed);
  const toolMaximized = useUi((state) => state.toolMaximized);
  const leftWidth = useUi((state) => state.leftWidth);
  const rightWidth = useUi((state) => state.rightWidth);
  const searchQuery = useUi((state) => state.searchQuery);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const centerRef = useRef<HTMLElement | null>(null);
  // Width of .center captured when maximize starts. The maximized panel is
  // position:fixed and leaves the flex flow, so without this pin .center
  // (flex:1) absorbs the freed width — the xterm container would grow, refit,
  // resize the PTY and reflow tmux, then reflow again on restore.
  const [frozenCenterWidth, setFrozenCenterWidth] = useState<number | null>(null);

  const maximize = useCallback(() => {
    setFrozenCenterWidth(centerRef.current?.getBoundingClientRect().width ?? null);
    useUi.getState().setToolMaximized(true);
  }, []);
  const restore = useCallback(() => {
    setFrozenCenterWidth(null);
    useUi.getState().setToolMaximized(false);
  }, []);

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
      if (matchesBinding(event, KEYBINDINGS.exitMaximize)) {
        // Esc belongs to an open dialog first (Modal closes itself); only
        // then does it leave maximize mode / the center diff
        if (document.querySelector(".modal-backdrop")) return;
        const ui = useUi.getState();
        if (ui.toolMaximized) {
          event.preventDefault();
          restore();
        } else if (ui.openDiff) {
          event.preventDefault();
          ui.setOpenDiff(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [restore]);

  // Keep in sync with the @media (max-width: 760px) blocks in theme.css.
  const isMobile = useMediaQuery("(max-width: 760px)");
  const mobilePanel = useUi((state) => state.mobilePanel);

  // Crossing the breakpoint clears leftover pane state; desktop collapse
  // flags keep their own persisted semantics.
  useEffect(() => {
    if (isMobile) useUi.getState().setMobilePanel("none");
  }, [isMobile]);

  // Mobile: a tapped file opens the DiffView in the center pane — behind the
  // tools drawer, so the drawer must step aside for it to be visible.
  useEffect(() => {
    if (isMobile && openDiff) useUi.getState().setMobilePanel("none");
  }, [isMobile, openDiff]);

  // Soft keyboards cover the bottom chrome on iOS (Android resizes the
  // layout via interactive-widget=resizes-content). Expose the covered
  // height as --kb-overlap: the mobile app pads itself above the keyboard
  // and the terminal refits through its ResizeObserver. scale !== 1 is
  // pinch zoom, not the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (vv.scale !== 1) return;
      const overlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      document.documentElement.style.setProperty("--kb-overlap", `${Math.round(overlap)}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--kb-overlap");
    };
  }, []);

  const dragLeft = useDrag("left");
  const dragRight = useDrag("right");

  const working = sessions.filter((item) => item.runtime.activity === "working").length;
  const idle = sessions.filter(
    (item) => item.runtime.activity === "idle" || item.runtime.activity === "cooling",
  ).length;

  const diffCount = statusQuery.data?.entries.length ?? 0;

  const topbar = (
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
  );

  const centerContent = selected ? (
    <>
      <div className={openDiff ? "terminal-slot hidden" : "terminal-slot"}>
        <ErrorBoundary>
          <TerminalView key={selected.session.id} data={selected} variant="agent" />
        </ErrorBoundary>
      </div>
      {openDiff && (
        <ErrorBoundary>
          <DiffView
            sessionId={selected.session.id}
            path={openDiff.path}
            staged={openDiff.staged}
            letter={openDiff.letter}
            onClose={() => useUi.getState().setOpenDiff(null)}
          />
        </ErrorBoundary>
      )}
    </>
  ) : (
    <div className="empty-center">
      <h1>Shellboard</h1>
      <div>Manage shells, not agents.</div>
      <div className="muted">Create a project and a session in the sidebar to start.</div>
    </div>
  );

  const toolContent = selected ? (
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
  );

  // Phone layout: the three regions stay, but one pane at a time. The agent
  // terminal stays mounted underneath the overlays so the PTY never churns;
  // panes are switched from the bottom nav (statusbar's mobile replacement).
  if (isMobile) {
    return (
      <div className="app">
        {topbar}
        <div className="main">
          <main className="center">{centerContent}</main>
          {mobilePanel === "sessions" && (
            <aside
              className="sidebar mobile-drawer"
              aria-label="Sessions"
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest(".session-item")) {
                  useUi.getState().setMobilePanel("none");
                }
              }}
            >
              <div className="mobile-drawer-status">
                {working} working · {idle} idle
              </div>
              {sidebar}
            </aside>
          )}
          {mobilePanel === "tools" && (
            <aside className="toolview mobile-drawer" aria-label="Tools">
              <div className="tool-tabs">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={rightTab === tab.id ? "tool-tab active" : "tool-tab"}
                    onClick={() => useUi.getState().setRightTab(tab.id)}
                  >
                    {tab.label}
                    {tab.id === "diff" && diffCount > 0 && <span className="badge">{diffCount}</span>}
                  </button>
                ))}
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  title="Close panel"
                  aria-label="Close panel"
                  onClick={() => useUi.getState().setMobilePanel("none")}
                >
                  ×
                </button>
              </div>
              <div className="tool-body">{toolContent}</div>
            </aside>
          )}
        </div>
        <nav className="bottom-nav" aria-label="Panels">
          <button
            type="button"
            className={mobilePanel === "sessions" ? "active" : ""}
            onClick={() =>
              useUi.getState().setMobilePanel(mobilePanel === "sessions" ? "none" : "sessions")
            }
          >
            Sessions
            {sessions.length > 0 && <span className="badge">{sessions.length}</span>}
          </button>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={mobilePanel === "tools" && rightTab === tab.id ? "active" : ""}
              onClick={() => {
                const ui = useUi.getState();
                if (ui.mobilePanel === "tools" && ui.rightTab === tab.id) {
                  ui.setMobilePanel("none");
                } else {
                  ui.setRightTab(tab.id);
                  ui.setMobilePanel("tools");
                }
              }}
            >
              {tab.label}
              {tab.id === "diff" && diffCount > 0 && <span className="badge">{diffCount}</span>}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="app">
      {topbar}

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
            className="panel-reopen left"
            title={`Show sessions (${KEYBINDINGS.toggleLeft})`}
            aria-label="Show sessions"
            onClick={() => useUi.getState().toggleLeft()}
          >
            <span className="panel-reopen-chev">»</span>
            <span className="panel-reopen-label">Sessions</span>
          </button>
        )}

        <main
          className="center"
          ref={centerRef}
          style={
            toolMaximized && frozenCenterWidth !== null
              ? { flex: "none", width: frozenCenterWidth }
              : undefined
          }
        >
          {centerContent}
        </main>

        {/* the drag handle sits between the shell and the panel — on the
            divider the user actually sees, not past the window edge */}
        {!rightCollapsed && <div className="gutter" onPointerDown={dragRight} />}
        <aside
          className={
            rightCollapsed
              ? "toolview collapsed"
              : toolMaximized
                ? "toolview maximized"
                : "toolview"
          }
          style={{ width: toolMaximized ? undefined : rightWidth }}
        >
          <div className="tool-tabs">
            {toolMaximized && (
              <button
                type="button"
                className="btn primary"
                title="Back to agent shell (Escape)"
                onClick={restore}
              >
                Back to shell
              </button>
            )}
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
              title={
                toolMaximized
                  ? "Scale down panel (Esc also restores)"
                  : "Maximize panel (covers the agent shell; Esc restores)"
              }
              onClick={() => (toolMaximized ? restore() : maximize())}
            >
              ⛶
            </button>
            <button
              type="button"
              className="icon-btn"
              title={`Collapse panel (${KEYBINDINGS.toggleRight})`}
              onClick={() => {
                if (useUi.getState().toolMaximized) restore();
                useUi.getState().toggleRight();
              }}
            >
              »
            </button>
          </div>
          <div className="tool-body">
            {rightCollapsed ? null : toolContent}
          </div>
        </aside>
        {rightCollapsed && (
          <button
            type="button"
            className="panel-reopen right"
            title={`Show tool panel (${KEYBINDINGS.toggleRight})`}
            aria-label="Show tool panel"
            onClick={() => useUi.getState().toggleRight()}
          >
            <span className="panel-reopen-chev">«</span>
            <span className="panel-reopen-label">Tools</span>
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
