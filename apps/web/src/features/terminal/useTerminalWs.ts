import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readTerminalTheme, subscribeTheme } from "../../state/theme";
import { useUi } from "../../state/store";
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
  fit(): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  findNext(term?: string): void;
  findPrevious(term?: string): void;
}

const FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export function useTerminalWs(path: string): TerminalApi {
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
    term.open(container);

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f"
      ) {
        setSearchOpen(true);
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
      observer.disconnect();
      unsubscribeTheme();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
    // scrollback changes require a fresh Terminal instance
  }, [path, nonce, scrollback, fontSize, sendResize]);

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
    fit,
    searchOpen,
    setSearchOpen,
    findNext,
    findPrevious,
  };
}
