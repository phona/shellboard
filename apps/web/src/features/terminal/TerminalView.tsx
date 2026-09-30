import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SessionWithRuntime } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { IconCopy, IconFontMinus, IconFontPlus, IconFullscreen, IconHistory, IconPaste, IconSearch } from "../../components/icons";
import { Modal } from "../../components/Modal";
import { toast } from "../../state/toasts";
import { useUi } from "../../state/store";
import { useMediaQuery } from "../../util/useMediaQuery";
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
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  // Keep in sync with the @media (max-width: 760px) blocks in theme.css.
  const isMobile = useMediaQuery("(max-width: 760px)");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const queryClient = useQueryClient();
  const exited = variant === "agent" && runtime.activity === "exited";

  useEffect(() => {
    if (!menu) return;
    // Dismiss on the next pointerdown outside the menu, in capture phase. A
    // window click listener cannot be used: React flushes this effect
    // synchronously during the opening click, so the same click would close
    // the menu instantly. The opening gesture's pointerdown already happened.
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

  const openMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const next = {
      x: Math.min(rect.left, window.innerWidth - 172),
      y: rect.bottom + 4,
    };
    // The opener is exempt from pointerdown dismissal, so this is a toggle.
    setMenu((current) => (current ? null : next));
  };

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
          {isMobile ? (
            // AoE-style mobile chrome: one overflow entry instead of seven
            // unlabeled icon targets; every action is a labeled menu item.
            <button
              type="button"
              className="icon-btn"
              title="Terminal actions"
              aria-label="Terminal actions"
              aria-haspopup="menu"
              data-ctx-opener=""
              onClick={(event) => openMenu(event.currentTarget)}
            >
              ⋯
            </button>
          ) : (
            <>
              <button
                type="button"
                className="icon-btn"
                title="Search (Ctrl+F)"
                aria-label="Search in terminal"
                onClick={() => terminal.setSearchOpen(!terminal.searchOpen)}
              >
                <IconSearch />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Smaller font"
                aria-label="Smaller font"
                onClick={() => useUi.getState().setFontSize(useUi.getState().fontSize - 1)}
              >
                <IconFontMinus />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Larger font"
                aria-label="Larger font"
                onClick={() => useUi.getState().setFontSize(useUi.getState().fontSize + 1)}
              >
                <IconFontPlus />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Copy selection (Ctrl+C)"
                aria-label="Copy selection"
                onClick={terminal.copySelection}
              >
                <IconCopy />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Paste"
                aria-label="Paste"
                onClick={terminal.paste}
              >
                <IconPaste />
              </button>
              {variant === "agent" && (
                <button
                  type="button"
                  className="icon-btn"
                  title="History (one page up)"
                  aria-label="History: one page up"
                  onClick={terminal.historyPage}
                >
                  <IconHistory />
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                title="Fullscreen"
                aria-label="Fullscreen"
                onClick={() => setFullscreen((value) => !value)}
              >
                <IconFullscreen />
              </button>
            </>
          )}
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
                terminal.findNext(searchValue);
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

      {banner && (
        <div className={`terminal-banner ${exited ? "ended" : terminal.status}`}>
          <span>{banner}</span>
          {variant === "agent" && exited && (
            <button type="button" className="btn primary" onClick={() => void restart()}>
              Restart
            </button>
          )}
          {(terminal.status === "reconnecting" || terminal.status === "taken-over") && (
            <button type="button" onClick={terminal.reconnect}>
              {terminal.status === "taken-over" ? "take it back" : "retry now"}
            </button>
          )}
        </div>
      )}

      {/* Off-bottom indicator: reading history while live streams below.
          One tap resumes follow — there is no other way back on touch. */}
      {!terminal.atBottom && !banner && (
        <button
          type="button"
          className="live-pill"
          onClick={terminal.goLive}
          onMouseDown={(event) => event.preventDefault()}
          title="Jump to latest output (Ctrl+End)"
        >
          ↓ Latest
        </button>
      )}

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            onClick={() => {
              terminal.setSearchOpen(true);
              setMenu(null);
            }}
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => {
              useUi.getState().setFontSize(useUi.getState().fontSize + 1);
              setMenu(null);
            }}
          >
            Bigger font
          </button>
          <button
            type="button"
            onClick={() => {
              useUi.getState().setFontSize(useUi.getState().fontSize - 1);
              setMenu(null);
            }}
          >
            Smaller font
          </button>
          <button
            type="button"
            onClick={() => {
              terminal.copySelection();
              setMenu(null);
            }}
          >
            Copy selection
          </button>
          {variant === "agent" && (
            <button
              type="button"
              onClick={() => {
                terminal.historyPage();
                setMenu(null);
              }}
            >
              History page up
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setFullscreen((value) => !value);
              setMenu(null);
            }}
          >
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </div>
      )}

      {/* AoE-style accessory key row: soft keyboards have no Esc/Ctrl/arrows,
          which makes a shell unusable without it. Bytes go through the same
          WS path as typed input; mousedown preventDefault keeps the soft
          keyboard open. Copying: long-press drag selects, the ^C key flips
          into copy while a selection exists (same smart Ctrl+C as desktop). */}
      {isMobile && terminal.status === "connected" && !exited && (
        <div className="term-keys" role="group" aria-label="Terminal keys">
          <button
            type="button"
            aria-label="Up arrow"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminal.sendText("\x1b[A")}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Down arrow"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminal.sendText("\x1b[B")}
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminal.sendText("\t")}
          >
            Tab
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminal.sendText("\x1b")}
          >
            Esc
          </button>
          <button
            type="button"
            className={terminal.ctrlArmed ? "armed" : ""}
            aria-pressed={terminal.ctrlArmed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminal.setCtrlArmed(!terminal.ctrlArmed)}
          >
            Ctrl
          </button>
          <button
            type="button"
            aria-label={terminal.hasSelection ? "Copy selection" : "Ctrl+C"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (terminal.hasSelection) {
                terminal.copySelection();
                return;
              }
              terminal.setCtrlArmed(false);
              terminal.sendText("\x03");
            }}
          >
            {terminal.hasSelection ? "copy" : "^C"}
          </button>
          <button
            type="button"
            className="term-keys-paste"
            aria-label="Paste"
            onMouseDown={(event) => event.preventDefault()}
            onClick={terminal.paste}
          >
            <IconPaste />
          </button>
        </div>
      )}
    </div>
  );
}

