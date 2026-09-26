import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Project, SessionWithRuntime } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { toast } from "../../state/toasts";
import { useUi } from "../../state/store";
import { relativeTime } from "../../util/format";

const AGENT_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  gemini: "Gemini",
  shell: "Shell",
  custom: "Custom",
};

function useTick(ms: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return 0;
}

function SessionBranch({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["git", "status", sessionId],
    queryFn: () => api.git.status(sessionId),
    staleTime: 60_000,
    retry: 0,
    // One git subprocess per session row per focus adds up; the 60s staleTime
    // already bounds freshness, and mutations invalidate explicitly.
    refetchOnWindowFocus: false,
  });
  return <>{query.data?.branch ?? "—"}</>;
}

interface MenuState {
  x: number;
  y: number;
  session: SessionWithRuntime;
}

interface RenameState {
  session: SessionWithRuntime;
  value: string;
}

function SessionItem({
  item,
  selected,
  menuOpen,
  onMenu,
}: {
  item: SessionWithRuntime;
  selected: boolean;
  menuOpen: boolean;
  onMenu: (menu: MenuState | null) => void;
}) {
  const selectSession = useUi((state) => state.selectSession);
  return (
    <div className={selected ? "session-row selected" : "session-row"}>
      <button
        type="button"
        className="session-item"
        aria-current={selected ? "true" : undefined}
        onClick={() => selectSession(item.session.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ x: event.clientX, y: event.clientY, session: item });
        }}
        onKeyDown={(event) => {
          // Keyboard equivalent of right-click: open the session menu at the row.
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.left, y: rect.bottom, session: item });
        }}
      >
        <span className={`act-dot ${item.runtime.activity}`} title={item.runtime.activity} />
        <span className="text">
          <span className="name">{item.session.name}</span>
          <span className="meta">
            {AGENT_LABEL[item.session.agentType]} · <SessionBranch sessionId={item.session.id} /> ·{" "}
            {relativeTime(item.runtime.lastActivityAt)}
          </span>
        </span>
      </button>
      {/* Touch path to the session menu: no hover, and long-press does not
          reliably fire contextmenu on iOS. Hidden on pointer devices. */}
      <button
        type="button"
        className="icon-btn session-menu-btn"
        title="Session actions"
        aria-label={`Actions for ${item.session.name}`}
        aria-haspopup="menu"
        data-ctx-opener=""
        onClick={(event) => {
          if (menuOpen) {
            onMenu(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({
            x: Math.min(rect.left, window.innerWidth - 172),
            y: rect.bottom + 4,
            session: item,
          });
        }}
      >
        ⋯
      </button>
    </div>
  );
}

export function SessionSidebar() {
  useTick(5000);
  const queryClient = useQueryClient();
  const searchQuery = useUi((state) => state.searchQuery);
  const selectedSessionId = useUi((state) => state.selectedSessionId);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [confirmKill, setConfirmKill] = useState<SessionWithRuntime | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createSessionFor, setCreateSessionFor] = useState<Project | null>(null);

  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: api.sessions.list });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects.list });

  const kill = useMutation({
    mutationFn: (id: string) => api.sessions.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (err) => toast(err instanceof ApiError ? err.message : "kill failed", "error"),
  });
  const restart = useMutation({
    mutationFn: (id: string) => api.sessions.restart(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (err) => toast(err instanceof ApiError ? err.message : "restart failed", "error"),
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.sessions.rename(id, name),
    onSuccess: () => {
      setRename(null);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "rename failed", "error"),
  });

  useEffect(() => {
    if (!menu) return;
    // Dismiss on the next pointerdown outside the menu, in capture phase. A
    // window click listener cannot be used: React flushes this effect
    // synchronously during the opening click, so a click-opened menu would
    // close instantly. The opening gesture's pointerdown already happened.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".ctx-menu, [data-ctx-opener]")) return;
      setMenu(null);
    };
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const filter = searchQuery.trim().toLowerCase();
  const projects = (projectsQuery.data ?? []).filter((project) => {
    if (!filter) return true;
    const sessions = (sessionsQuery.data?.sessions ?? []).filter(
      (item) => item.session.projectId === project.id,
    );
    return (
      project.name.toLowerCase().includes(filter) ||
      sessions.some((item) => item.session.name.toLowerCase().includes(filter))
    );
  });
  const sessionsFor = (projectId: string): SessionWithRuntime[] =>
    (sessionsQuery.data?.sessions ?? []).filter((item) => item.session.projectId === projectId);

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <>
      <div className="sidebar-head">
        <span>SESSIONS</span>
        <button
          type="button"
          className="icon-btn"
          title="New project"
          onClick={() => setCreateProjectOpen(true)}
        >
          + project
        </button>
      </div>

      <div className="sidebar-body">
        {projectsQuery.isLoading && <div className="sidebar-empty">loading…</div>}
        {projectsQuery.isSuccess && projects.length === 0 && (
          <div className="sidebar-empty">
            No projects yet.
            <button
              type="button"
              className="btn primary"
              style={{ display: "block", margin: "10px auto 0" }}
              onClick={() => setCreateProjectOpen(true)}
            >
              Create project
            </button>
          </div>
        )}
        {projects.map((project) => {
          const sessions = sessionsFor(project.id).filter(
            (item) => !filter || item.session.name.toLowerCase().includes(filter),
          );
          const collapsed = collapsedProjects.has(project.id);
          return (
            <div key={project.id} className="project-group">
              <div
                className="project-head"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                title={project.rootPath}
                onClick={() => toggleProject(project.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  toggleProject(project.id);
                }}
              >
                <span className={collapsed ? "chevron" : "chevron open"}>▸</span>
                <span>{project.name}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  title="New session"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCreateSessionFor(project);
                  }}
                >
                  +
                </button>
              </div>
              {!collapsed &&
                sessions.map((item) => (
                  <SessionItem
                    key={item.session.id}
                    item={item}
                    selected={item.session.id === selectedSessionId}
                    menuOpen={menu?.session.session.id === item.session.id}
                    onMenu={setMenu}
                  />
                ))}
              {!collapsed && sessions.length === 0 && (
                <div className="sidebar-empty" style={{ padding: "6px 26px", textAlign: "left" }}>
                  no sessions
                </div>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            onClick={() => {
              setRename({ session: menu.session, value: menu.session.session.name });
              setMenu(null);
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            onClick={() => {
              restart.mutate(menu.session.session.id);
              setMenu(null);
            }}
          >
            Restart
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(menu.session.session.cwd)
                .then(() => toast("cwd copied"))
                .catch(() => toast("copy failed", "error"));
              setMenu(null);
            }}
          >
            Copy cwd
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setConfirmKill(menu.session);
              setMenu(null);
            }}
          >
            Kill
          </button>
        </div>
      )}

      {rename && (
        <Modal title="Rename session" onClose={() => setRename(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              renameMutation.mutate({ id: rename.session.session.id, name: rename.value });
            }}
          >
            <label>
              Name
              <input
                autoFocus
                value={rename.value}
                onChange={(event) => setRename({ ...rename, value: event.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setRename(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirmKill && (
        <Modal title="Kill session" onClose={() => setConfirmKill(null)}>
          <div>
            Kill <strong>{confirmKill.session.name}</strong>? The tmux session and its agent
            process will be terminated.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmKill(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                kill.mutate(confirmKill.session.id);
                setConfirmKill(null);
              }}
            >
              Kill
            </button>
          </div>
        </Modal>
      )}

      {createProjectOpen && (
        <CreateProjectDialog
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(project) => setCreateSessionFor(project)}
        />
      )}
      {createSessionFor && (
        <CreateSessionDialog
          project={createSessionFor}
          onClose={() => setCreateSessionFor(null)}
        />
      )}
    </>
  );
}
