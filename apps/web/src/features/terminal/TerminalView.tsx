import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SessionWithRuntime } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { toast } from "../../state/toasts";
import { useUi } from "../../state/store";
import type { TerminalStatus } from "./useTerminalWs";
import { useTerminalWs } from "./useTerminalWs";

const STATUS_BANNER: Partial<Record<TerminalStatus, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  "taken-over": "Taken over by another client",
};

export function TerminalView({
  data,
  variant,
}: {
  data: SessionWithRuntime;
  variant: "agent" | "tool";
}) {
  const { session, runtime } = data;
  const terminal = useTerminalWs(
    variant === "agent"
      ? `/api/sessions/${session.id}/terminal`
      : `/api/sessions/${session.id}/tools/terminal`,
    // tmux owns the agent scrollback; the tool shell scrolls natively
    variant === "agent",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const queryClient = useQueryClient();
  const exited = variant === "agent" && runtime.activity === "exited";

  const restart = async () => {
    try {
      await api.sessions.restart(session.id);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      terminal.reconnect();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "restart failed", "error");
    }
  };

  const banner =
    variant === "agent" && exited
      ? "session exited"
      : STATUS_BANNER[terminal.status];

  const showHistoryBar =
    variant === "agent" && terminal.historyMode && !banner && terminal.status === "connected";

  return (
    <div className={fullscreen ? "terminal-view fullscreen" : "terminal-view"}>
      <div className="terminal-head">
        <div className="terminal-title">
          {variant === "agent" ? session.name : `${session.name} · tool shell`}
          {variant === "agent" && (
            <span className={`act-dot ${runtime.activity}`} title={runtime.activity} />
          )}
          {variant === "tool" && <span className="muted">ephemeral — dies with the tab</span>}
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="icon-btn"
            title="Search (Ctrl+F)"
            onClick={() => terminal.setSearchOpen(!terminal.searchOpen)}
          >
            ⌕
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Smaller font"
            onClick={() => useUi.getState().setFontSize(useUi.getState().fontSize - 1)}
          >
            A−
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Larger font"
            onClick={() => useUi.getState().setFontSize(useUi.getState().fontSize + 1)}
          >
            A+
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Copy selection (Shift+drag to select)"
            onClick={terminal.copySelection}
          >
            ⧉
          </button>
          <button type="button" className="icon-btn" title="Paste" onClick={terminal.paste}>
            ⎘
          </button>
          {variant === "agent" && (
            <button
              type="button"
              className="icon-btn"
              title="History (one page up)"
              onClick={terminal.historyPage}
            >
              ⇲
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Fullscreen"
            onClick={() => setFullscreen((value) => !value)}
          >
            ⛶
          </button>
        </div>
      </div>

      {terminal.searchOpen && (
        <div className="terminal-search">
          <input
            autoFocus
            value={searchValue}
            placeholder="search in terminal"
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                terminal.findNext();
              }
              if (event.key === "Escape") terminal.setSearchOpen(false);
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="Previous"
            onClick={() => terminal.findPrevious(searchValue)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Next"
            onClick={() => terminal.findNext(searchValue)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close"
            onClick={() => terminal.setSearchOpen(false)}
          >
            ×
          </button>
        </div>
      )}

      <div className="terminal-host" ref={terminal.containerRef} />

      {terminal.pasteConfirmation && (
        <Modal title="Paste multi-line text" onClose={terminal.cancelPaste}>
          <div>
            The clipboard contains <strong>{terminal.pasteConfirmation.lines} lines</strong>.
            Pasting feeds them to the terminal line by line — each line may execute. Review
            the content before confirming.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={terminal.cancelPaste}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={terminal.confirmPaste}>
              Paste
            </button>
          </div>
        </Modal>
      )}

      {showHistoryBar && (
        <div className="terminal-banner history">
          <span>HISTORY — typing returns to live</span>
          <button
            type="button"
            className="btn primary"
            onClick={terminal.scrollToLive}
            title="Jump to bottom (Ctrl+End)"
          >
            ↓ live
          </button>
        </div>
      )}

      {banner && (
        <div className={`terminal-banner ${exited ? "ended" : terminal.status}`}>
          <span>{banner}</span>
          {variant === "agent" && exited && (
            <button type="button" className="btn primary" onClick={() => void restart()}>
              Restart
            </button>
          )}
          {terminal.status === "reconnecting" && (
            <button type="button" onClick={terminal.reconnect}>
              retry now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
