import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readTerminalTheme, subscribeTheme } from "../../state/theme";
import { useUi } from "../../state/store";
import { toast } from "../../state/toasts";
import { KEYBINDINGS, matchesBinding } from "../../util/dom";
import { wsUrl } from "../../api/client";

export type TerminalStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "taken-over";

export interface TerminalApi {
  containerRef: RefObject<HTMLDivElement>;
  status: TerminalStatus;
  reconnect(): void;
  sendText(text: string): void;
  paste(): void;
  copySelection(): void;
  fit(): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  findNext(term?: string): void;
  findPrevious(term?: string): void;
}

const FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export function useTerminalWs(path: string, wheelScroll = false): TerminalApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [searchOpen, setSearchOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fontSize = useUi((state) => state.fontSize);
  const scrollback = useUi((state) => state.scrollback);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit();
    } catch {
      // container not laid out yet
    }
    sendResize();
  }, [sendResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let remoteEnded = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: FONT_FAMILY,
      scrollback,
      theme: readTerminalTheme(),
      // Unicode11Addon relies on the proposed unicode API
      allowProposedApi: true,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    const searchAddon = new SearchAddon();
    searchRef.current = searchAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container);

    // Desktop-style selection by default: swallow mouse-reporting modes
    // (DECSET 1000/1002/1003/1006/1015) and alternate scroll (1007), so
    // plain drag is a native browser selection and the wheel never degrades
    // to arrow keys.
    const isMouseMode = (value: number | number[]): boolean =>
      (typeof value === "number" ? [value] : value).every((n) =>
        [1000, 1002, 1003, 1006, 1007, 1015].includes(n),
      );
    const swallowMouse = (params: (number | number[])[]): boolean =>
      params.length > 0 && params.every(isMouseMode);
    term.parser.registerCsiHandler({ final: "h", intermediates: "?" }, swallowMouse);
    term.parser.registerCsiHandler({ final: "l", intermediates: "?" }, swallowMouse);

    // Wheel: tmux owns the scrollback, so forward scroll intents to the
    // server (it drives tmux copy-mode). Accumulated and throttled.
    let wheelAccum = 0;
    let wheelTimer: number | null = null;
    const flushWheel = () => {
      wheelTimer = null;
      const lines = Math.max(-40, Math.min(40, Math.round(wheelAccum)));
      wheelAccum = 0;
      const ws = wsRef.current;
      if (lines !== 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "scroll", lines }));
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      wheelAccum += event.deltaY / 18;
      if (wheelTimer === null) {
        wheelTimer = window.setTimeout(flushWheel, 90);
      }
    };
    if (wheelScroll) {
      container.addEventListener("wheel", onWheel, { passive: false, capture: true });
    }

    // OSC 52: tmux copy commands and inner CLIs arrive here; bridge them
    // into the browser clipboard.
    term.parser.registerOscHandler(52, (data) => {
      const split = data.indexOf(";");
      if (split === -1) return false;
      const payload = data.slice(split + 1);
      if (!payload) return true; // clipboard clear request
      try {
        const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        void navigator.clipboard.writeText(text).catch(() => {
          toast("Copy blocked by the browser — select, then press Ctrl+C", "error");
        });
        return true;
      } catch {
        return false;
      }
    });

    // Copy-on-release: releasing a selection copies it, like an editor
    // with copy-on-select.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const selection = term.getSelection();
      if (!selection) return;
      void navigator.clipboard.writeText(selection).catch(() => {
        toast("Copy blocked by the browser — press Ctrl+C instead", "error");
      });
    };
    container.addEventListener("mouseup", onMouseUp, true);

    // Right-click = paste (PuTTY style). Capture phase wins over xterm.
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // clipboard permission denied
        });
    };
    container.addEventListener("contextmenu", contextMenu, true);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (matchesBinding(event, KEYBINDINGS.terminalSearch)) {
        setSearchOpen(true);
        return false;
      }
      if (matchesBinding(event, KEYBINDINGS.terminalCopy) && term.hasSelection()) {
        void navigator.clipboard
          .writeText(term.getSelection())
          .catch(() => {
            // clipboard permission denied
          });
        term.clearSelection();
        return false;
      }
      if (
        matchesBinding(event, KEYBINDINGS.terminalPaste) ||
        matchesBinding(event, KEYBINDINGS.terminalPasteShift)
      ) {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {
            toast("Paste blocked by the browser — use the paste button", "error");
          });
        return false;
      }
      return true;
    });
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoderRef.current.encode(data));
      }
    });

    const doFit = () => {
      try {
        fitAddon.fit();
      } catch {
        // container not laid out yet
      }
      sendResize();
    };

    const connect = () => {
      if (disposed) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(wsUrl(path));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("connected");
        doFit();
        ws.send(JSON.stringify({ type: "init", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        try {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === "taken-over") {
            setStatus("taken-over");
          } else if (message.type === "ended") {
            remoteEnded = true;
            setStatus("ended");
          }
        } catch {
          // non-JSON control frame
        }
      };
      ws.onclose = (event) => {
        wsRef.current = null;
        if (disposed || remoteEnded || event.code === 4001) return;
        setStatus("reconnecting");
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(500 * 2 ** attempt, 5000));
      };
      ws.onerror = () => ws.close();
    };

    const observer = new ResizeObserver(() => doFit());
    observer.observe(container);
    const unsubscribeTheme = subscribeTheme(() => {
      term.options.theme = readTerminalTheme();
    });
    term.focus();
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      container.removeEventListener("contextmenu", contextMenu, true);
      container.removeEventListener("mouseup", onMouseUp, true);
      if (wheelScroll) {
        container.removeEventListener("wheel", onWheel, { capture: true });
        if (wheelTimer !== null) window.clearTimeout(wheelTimer);
      }
      observer.disconnect();
      unsubscribeTheme();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
    // scrollback changes require a fresh Terminal instance
  }, [path, nonce, scrollback, fontSize, sendResize, wheelScroll]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      fitRef.current?.fit();
    } catch {
      // container not laid out yet
    }
    sendResize();
  }, [fontSize, sendResize]);

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encoderRef.current.encode(text));
    }
  }, []);

  const paste = useCallback(() => {
    navigator.clipboard
      .readText()
      .then((text) => termRef.current?.paste(text))
      .catch(() => {
        // clipboard permission denied
      });
  }, []);

  const copySelection = useCallback(() => {
    const selection = termRef.current?.getSelection();
    if (!selection) return;
    void navigator.clipboard
      .writeText(selection)
      .then(() => termRef.current?.clearSelection())
      .catch(() => {
        // clipboard permission denied
      });
  }, []);

  const findNext = useCallback((term?: string) => {
    const search = searchRef.current;
    if (!search || term === undefined || term.length === 0) return;
    search.findNext(term);
  }, []);
  const findPrevious = useCallback((term?: string) => {
    const search = searchRef.current;
    if (!search || term === undefined || term.length === 0) return;
    search.findPrevious(term);
  }, []);

  return {
    containerRef,
    status,
    reconnect,
    sendText,
    paste,
    copySelection,
    fit,
    searchOpen,
    setSearchOpen,
    findNext,
    findPrevious,
  };
}
