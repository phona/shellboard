import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SessionWithRuntime, WsEvent } from "@shellboard/contracts";
import { useUi } from "../state/store.js";
import { toast } from "../state/toasts.js";
import { wsUrl } from "../api/client.js";

export function useEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let timer: number | null = null;
    const prevActivity = new Map<string, string>();

    const handle = (raw: string): void => {
      let event: WsEvent;
      try {
        event = JSON.parse(raw) as WsEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "session.created":
        case "session.updated":
        case "session.deleted": {
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          if (event.type === "session.deleted") {
            const selected = useUi.getState().selectedSessionId;
            if (selected === event.sessionId) useUi.getState().selectSession(null);
          }
          break;
        }
        case "session.activity": {
          const list = queryClient.getQueryData<{
            sessions: SessionWithRuntime[];
          }>(["sessions"]);
          const name =
            list?.sessions.find((item) => item.session.id === event.runtime.sessionId)
              ?.session.name ?? "session";
          const prev = prevActivity.get(event.runtime.sessionId);
          prevActivity.set(event.runtime.sessionId, event.runtime.activity);
          const { notifications } = useUi.getState();
          if (
            notifications &&
            document.hidden &&
            prev === "working" &&
            event.runtime.activity === "idle" &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            new Notification("Shellboard", { body: `${name} is now idle` });
          }
          queryClient.setQueryData<{ sessions: SessionWithRuntime[] }>(
            ["sessions"],
            (old) =>
              old
                ? {
                    sessions: old.sessions.map((item) =>
                      item.session.id === event.runtime.sessionId
                        ? { ...item, runtime: event.runtime }
                        : item,
                    ),
                  }
                : old,
          );
          break;
        }
        case "git.status_changed":
          void queryClient.invalidateQueries({ queryKey: ["git"] });
          break;
        case "session.notify": {
          const { notifications, selectSession } = useUi.getState();
          const sessionId = event.session?.id ?? null;
          const message = event.body ? `${event.title} — ${event.body}` : event.title;
          toast(
            message.length > 200 ? `${message.slice(0, 199)}…` : message,
            event.level === "error" ? "error" : "info",
            sessionId ? { label: "Show", onClick: () => selectSession(sessionId) } : undefined,
          );
          if (
            notifications &&
            document.hidden &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            new Notification(event.session ? `Shellboard · ${event.session.name}` : "Shellboard", {
              body: event.body ? `${event.title}\n${event.body}` : event.title,
            });
          }
          break;
        }
      }
    };

    const connect = (): void => {
      if (closed) return;
      ws = new WebSocket(wsUrl("/api/events"));
      ws.onopen = () => {
        // A healthy connection resets the backoff. Without this the delay
        // stays pinned at the maximum after the first drop, so every later
        // reconnect waits the full 10s.
        attempt = 0;
        // Events broadcast while the socket was down are lost for good —
        // nothing replays them. The session list also polls every 15s, but
        // git status and the uploads buffer are stream-only, so resync both
        // on every (re)connect.
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["git"] });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") handle(ev.data);
      };
      ws.onclose = () => {
        if (closed) return;
        attempt += 1;
        timer = window.setTimeout(connect, Math.min(1000 * attempt, 10000));
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      ws?.close();
    };
  }, [queryClient]);
}
