import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { IconPanelLeft, IconPanelRight } from "../components/icons";
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
      aria-label="Cycle theme"
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
  const terminalEpoch = useUi((state) => state.terminalEpoch);
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
  const sessionToggleRef = useRef<HTMLButtonElement | null>(null);
  const mobileTopbarRef = useRef<HTMLElement | null>(null);
  const mobileCenterRef = useRef<HTMLElement | null>(null);
  const sessionDrawerRef = useRef<HTMLElement | null>(null);
  const sessionBackdropRef = useRef<HTMLButtonElement | null>(null);
  const sessionCloseRef = useRef<HTMLButtonElement | null>(null);
  const swipeCleanupRef = useRef<(() => void) | null>(null);
  const suppressSessionClickRef = useRef(false);
  // Width of .center captured when maximize starts. The maximized panel is
  // position:fixed and leaves the flex flow, so without this pin .center
  // (flex:1) absorbs the freed width — the xterm container would grow, refit,
  // resize the PTY and reflow tmux, then reflow again on restore.
  const [frozenCenterWidth, setFrozenCenterWidth] = useState<number | null>(null);
  const [mobileTerminalActionsTarget, setMobileTerminalActionsTarget] = useState<HTMLDivElement | null>(null);

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
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects.list });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const selected = sessions.find((item) => item.session.id === selectedSessionId) ?? null;
  const selectedProject = projectsQuery.data?.find(
    (project) => project.id === selected?.session.projectId,
  );
  const remoteProject = selectedProject?.location.kind === "ssh";

  const statusQuery = useQuery({
    queryKey: ["git", "status", selectedSessionId],
    queryFn: () => api.git.status(selectedSessionId ?? ""),
    enabled: selected !== null && selectedProject?.location.kind === "local",
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      useUi.getState().selectSession(sessions[0]?.session.id ?? null);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (
      selectedSessionId &&
      !selected &&
      sessionsQuery.isSuccess &&
      !sessionsQuery.isFetching
    ) {
      useUi.getState().selectSession(null);
    }
  }, [selectedSessionId, selected, sessionsQuery.isSuccess, sessionsQuery.isFetching]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesBinding(event, KEYBINDINGS.exitMaximize) && useUi.getState().mobilePanel === "sessions") {
        if (document.querySelector(".modal-backdrop")) return;
        event.preventDefault();
        useUi.getState().setMobilePanel("none");
        requestAnimationFrame(() => sessionToggleRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (matchesBinding(event, KEYBINDINGS.search)) {
        // A dialog owns the keyboard: focusing the topbar search would
        // silently capture the next keystrokes behind the backdrop and
        // leave the list mysteriously filtered when it closes.
        if (document.querySelector(".modal-backdrop") || useUi.getState().mobilePanel === "sessions") return;
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (matchesBinding(event, KEYBINDINGS.exitMaximize)) {
        // Esc belongs to an open dialog first (Modal closes itself); only
        // then does it leave maximize mode or the center diff.
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

  const closeSessions = useCallback(() => {
    useUi.getState().setMobilePanel("none");
    requestAnimationFrame(() => sessionToggleRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (isMobile && mobilePanel === "sessions") {
      sessionCloseRef.current?.focus({ preventScroll: true });
    }
  }, [isMobile, mobilePanel]);

  useEffect(() => {
    if (!isMobile) return;
    const topbar = mobileTopbarRef.current;
    const center = mobileCenterRef.current;
    if (topbar) topbar.inert = mobilePanel === "sessions";
    if (center) center.inert = mobilePanel === "sessions";
    return () => {
      if (topbar) topbar.inert = false;
      if (center) center.inert = false;
    };
  }, [isMobile, mobilePanel]);

  useEffect(() => () => swipeCleanupRef.current?.(), []);

  const startSessionSwipe = (event: React.TouchEvent, mode: "open" | "close") => {
    if (event.touches.length !== 1 || swipeCleanupRef.current) return;
    if (mode === "open" && mobilePanel !== "none") return;
    if (mode === "close" && mobilePanel !== "sessions") return;
    const target = event.target as HTMLElement;
    if (mode === "open" && target.closest("button, input, textarea, select, .term-keys, .ctx-menu")) return;
    if (mode === "close" && target.closest("input, textarea, select")) return;
    const drawer = sessionDrawerRef.current;
    const backdrop = sessionBackdropRef.current;
    if (!drawer || !backdrop) return;
    const firstTouch = event.touches[0];
    if (!firstTouch) return;
    const touchId = firstTouch.identifier;
    const startX = firstTouch.clientX;
    const startY = firstTouch.clientY;
    const startedAt = performance.now();
    const startedInTerminal = mode === "open" && target.closest(".terminal-host") !== null;
    const width = drawer.offsetWidth;
    let lastX = startX;
    let lastAt = performance.now();
    let velocity = 0;
    let progress = mode === "open" ? 0 : 1;
    let claimed = false;
    let cancelled = false;

    const cleanup = () => {
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", cancel);
      swipeCleanupRef.current = null;
    };
    const settle = (aborted: boolean) => {
      cleanup();
      if (!claimed) return;
      const open = aborted
        ? mode === "close"
        : mode === "open"
          ? progress >= 0.35 || velocity > 0.5
          : progress > 0.65 && velocity >= -0.5;
      suppressSessionClickRef.current = true;
      window.setTimeout(() => { suppressSessionClickRef.current = false; }, 0);
      if (open) useUi.getState().setMobilePanel("sessions");
      else closeSessions();
      requestAnimationFrame(() => {
        drawer.classList.remove("dragging");
        backdrop.classList.remove("dragging");
        drawer.style.removeProperty("transform");
        drawer.style.removeProperty("visibility");
        backdrop.style.removeProperty("opacity");
        backdrop.style.removeProperty("visibility");
      });
    };
    const move = (next: TouchEvent) => {
      if (cancelled) return;
      const touch = Array.from(next.touches).find((item) => item.identifier === touchId);
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      let releaseFirstMoveToTerminal = false;
      if (!claimed) {
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
        // A held finger belongs to terminal text selection, not navigation.
        if (mode === "open" && performance.now() - startedAt > 350) {
          cancelled = true;
          return;
        }
        if (Math.abs(dx) <= Math.abs(dy) * 1.25 || (mode === "open" ? dx < 0 : dx > 0)) {
          cancelled = true;
          return;
        }
        claimed = true;
        // The terminal's first move cancels its 500ms long-press selection
        // timer. Later horizontal moves belong to the drawer gesture.
        releaseFirstMoveToTerminal = startedInTerminal;
        drawer.classList.add("dragging");
        backdrop.classList.add("dragging");
        drawer.style.visibility = "visible";
        backdrop.style.visibility = "visible";
      }
      if (!releaseFirstMoveToTerminal) {
        next.preventDefault();
        next.stopPropagation();
      }
      progress = Math.max(0, Math.min(1, (mode === "open" ? dx : width + dx) / width));
      drawer.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
      backdrop.style.opacity = String(progress);
      const now = performance.now();
      velocity = (touch.clientX - lastX) / Math.max(now - lastAt, 1);
      lastX = touch.clientX;
      lastAt = now;
    };
    const end = (next: TouchEvent) => {
      if (!Array.from(next.changedTouches).some((item) => item.identifier === touchId)) return;
      if (performance.now() - lastAt > 100) velocity = 0;
      settle(false);
    };
    const cancel = (next: TouchEvent) => {
      if (Array.from(next.changedTouches).some((item) => item.identifier === touchId)) settle(true);
    };
    swipeCleanupRef.current = cleanup;
    window.addEventListener("touchmove", move, { passive: false, capture: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", cancel);
  };

  // Crossing the breakpoint clears leftover pane state; desktop collapse
  // flags keep their own persisted semantics.
  useEffect(() => {
    if (useUi.getState().mobilePanel !== "none") useUi.getState().setMobilePanel("none");
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
        aria-label="Search sessions"
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
          <TerminalView
            key={`${selected.session.id}:${terminalEpoch}`}
            data={selected}
            variant="agent"
            allowUploads={!remoteProject}
            mobileActionsTarget={mobileTerminalActionsTarget}
          />
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

  const toolContent = selected && !selectedProject ? (
    <div className="tool-placeholder">Loading project…</div>
  ) : selected && remoteProject ? (
    <div className="tool-placeholder">
      <strong>Remote tools unavailable</strong>
      <span>Git, Files, Tool Terminal, and Uploads are not supported for this project yet.</span>
    </div>
  ) : selected ? (
    <ErrorBoundary>
      {rightTab === "diff" ? (
        <DiffPanel key={selected.session.id} data={selected} />
      ) : rightTab === "files" ? (
        // key: remount on session switch, like the tool terminal below —
        // panel state (open file, directory, staged filter) must not carry
        // across sessions, and an unsaved edit must never land in the
        // newly selected session's file.
        <FilesPanel key={selected.session.id} data={selected} />
      ) : (
        // key: remount on session switch — the hook's off-bottom state
        // (live pill) is component state and must not carry across sessions
        <TerminalView key={`tool-${selected.session.id}`} data={selected} variant="tool" />
      )}
    </ErrorBoundary>
  ) : (
    <div className="tool-placeholder">Select a session</div>
  );

  // Phone layout: the three regions stay, but one pane at a time. The agent
  // terminal stays mounted underneath the overlays so the PTY never churns.
  // Single control plane, AoE-style: pane toggles live in the top bar and
  // the accessory key row is the only bar at the bottom.
  const mobileTopbar = (
    <header className="topbar" ref={mobileTopbarRef}>
      <button
        ref={sessionToggleRef}
        type="button"
        className={
          mobilePanel === "sessions" ? "icon-btn topbar-toggle active" : "icon-btn topbar-toggle"
        }
        title="Sessions"
        aria-label="Toggle sessions panel"
        aria-controls="mobile-session-drawer"
        aria-expanded={mobilePanel === "sessions"}
        onClick={() =>
          useUi.getState().setMobilePanel(mobilePanel === "sessions" ? "none" : "sessions")
        }
      >
        <IconPanelLeft />
        {sessions.length > 0 && <span className="badge">{sessions.length}</span>}
      </button>
      <div className="topbar-title">
        {selected ? (
          <>
            <span className="topbar-name">{selected.session.name}</span>
            <span
              className={`act-dot ${selected.runtime.activity}`}
              title={selected.runtime.activity}
            />
          </>
        ) : (
          <span className="topbar-name">Shellboard</span>
        )}
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className={
            mobilePanel === "tools" ? "icon-btn topbar-toggle active" : "icon-btn topbar-toggle"
          }
          title="Diff, files, tool shell"
          aria-label="Toggle tools panel"
          aria-expanded={mobilePanel === "tools"}
          onClick={() => useUi.getState().setMobilePanel(mobilePanel === "tools" ? "none" : "tools")}
        >
          <IconPanelRight />
          {diffCount > 0 && <span className="badge">{diffCount}</span>}
        </button>
        <div
          ref={setMobileTerminalActionsTarget}
          className={openDiff || mobilePanel === "tools"
            ? "mobile-terminal-action-slot hidden"
            : "mobile-terminal-action-slot"}
        />
      </div>
    </header>
  );

  if (isMobile) {
    return (
      <div className="app">
        {mobileTopbar}
        <div
          className="main"
          onTouchStartCapture={(event) => {
            const touch = event.touches[0];
            if (touch && touch.clientX <= Math.min(160, window.innerWidth * 0.4)) {
              startSessionSwipe(event, "open");
            }
          }}
        >
          <main className="center" ref={mobileCenterRef}>{centerContent}</main>
          <button
            ref={sessionBackdropRef}
            type="button"
            className={mobilePanel === "sessions" ? "mobile-session-backdrop open" : "mobile-session-backdrop"}
            aria-label="Close sessions panel"
            tabIndex={-1}
            onClick={closeSessions}
          />
          {/* Keep the drawer mounted for the exit transition. The terminal
              stays at its original size underneath throughout the gesture. */}
          <aside
            ref={sessionDrawerRef}
            id="mobile-session-drawer"
            className={mobilePanel === "sessions" ? "sidebar mobile-drawer mobile-session-drawer open" : "sidebar mobile-drawer mobile-session-drawer"}
            role="dialog"
            aria-modal="true"
            aria-label="Sessions"
            aria-hidden={mobilePanel !== "sessions"}
            onTouchStart={(event) => startSessionSwipe(event, "close")}
            onClickCapture={(event) => {
              if (suppressSessionClickRef.current) {
                event.preventDefault();
                event.stopPropagation();
                suppressSessionClickRef.current = false;
              }
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest(".session-item")) closeSessions();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = Array.from(
                sessionDrawerRef.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ) ?? [],
              ).filter((element) => element.getClientRects().length > 0);
              const first = focusable[0];
              const last = focusable.at(-1);
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="mobile-drawer-top">
              <button
                ref={sessionCloseRef}
                type="button"
                className="icon-btn mobile-drawer-close"
                aria-label="Close sessions"
                onClick={closeSessions}
              >
                ×
              </button>
              <input
                className="search"
                placeholder="Search sessions"
                aria-label="Search sessions"
                value={searchQuery}
                onChange={(event) => useUi.getState().setSearchQuery(event.target.value)}
              />
              <span className="mobile-drawer-counts">
                {working} working · {idle} idle
              </span>
            </div>
            {sidebar}
            <SettingsPopover inline />
          </aside>
          {mobilePanel === "tools" && (
            <aside className="toolview mobile-drawer" aria-label="Tools">
              <div className="tool-tabs">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={rightTab === tab.id ? "tool-tab active" : "tool-tab"}
                    disabled={remoteProject}
                    title={remoteProject ? "Remote tools are not supported yet" : undefined}
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
                disabled={remoteProject}
                title={remoteProject ? "Remote tools are not supported yet" : undefined}
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
              aria-label={toolMaximized ? "Scale down panel" : "Maximize panel"}
              onClick={() => (toolMaximized ? restore() : maximize())}
            >
              ⛶
            </button>
            <button
              type="button"
              className="icon-btn"
              title={`Collapse panel (${KEYBINDINGS.toggleRight})`}
              aria-label="Collapse panel"
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
        {sessions.length > 0 && (
          <span>
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        )}
        {sessions.length > 0 && (
          <span>
            <span className="dot">●</span> {working} working · {idle} idle
          </span>
        )}
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
