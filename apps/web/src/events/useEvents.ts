import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SessionWithRuntime, WsEvent } from "@shellboard/contracts";
import { useUi } from "../state/store.js";
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
      }
    };

    const connect = (): void => {
      if (closed) return;
      ws = new WebSocket(wsUrl("/api/events"));
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
