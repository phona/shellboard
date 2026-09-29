import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readMonoFontStack, readTerminalTheme, subscribeTheme } from "../../state/theme";
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
  /** Viewport sits on the live bottom (false = user is reading history). */
  atBottom: boolean;
  /** A text selection exists (the mobile key row flips ^C into copy). */
  hasSelection: boolean;
  /** Snap the viewport back to the live bottom and resume follow. */
  goLive(): void;
  reconnect(): void;
  sendText(text: string): void;
  /** Sticky mobile Ctrl modifier: the next character is sent as its control code. */
  ctrlArmed: boolean;
  setCtrlArmed(value: boolean): void;
  /** One page up through the local buffer. */
  historyPage(): void;
  paste(): void;
  /** Multi-line paste gate: set before anything containing newlines runs. */
  pasteConfirmation: { lines: number } | null;
  confirmPaste(): void;
  cancelPaste(): void;
  copySelection(): void;
  clearSelection(): void;
  fit(): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  findNext(term?: string): void;
  findPrevious(term?: string): void;
}

export function useTerminalWs(path: string): TerminalApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchOptionsRef = useRef<ISearchOptions | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef(new TextEncoder());
  // Input typed while the socket is down is queued, not dropped (D5: the
  // client buffer is lossless — that promise covered output only). Bounded
  // so a long outage cannot grow memory without limit; a chunk that does
  // not fit is dropped with a toast, earlier keystrokes survive.
  const inputQueueRef = useRef<{ chunks: Uint8Array[]; bytes: number }>({ chunks: [], bytes: 0 });
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pasteConfirmation, setPasteConfirmation] = useState<{ lines: number } | null>(null);
  const pendingPasteRef = useRef<string | null>(null);
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const ctrlArmedRef = useRef(false);
  // Live-follow state: false once the user deliberately scrolls up; new
  // output then stops pulling the viewport down until they return. The
  // buffer is the real transcript, so off-bottom is knowable exactly.
  const userPinnedRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasSelection, setHasSelection] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fontSize = useUi((state) => state.fontSize);
  const scrollback = useUi((state) => state.scrollback);

  const INPUT_QUEUE_BYTES = 64 * 1024;
  const queueInput = useCallback((bytes: Uint8Array): void => {
    const queue = inputQueueRef.current;
    if (queue.bytes + bytes.length > INPUT_QUEUE_BYTES) {
      toast("Input dropped — too much typed while disconnected", "error");
      return;
    }
    queue.chunks.push(bytes);
    queue.bytes += bytes.length;
  }, []);
  const flushInputQueue = useCallback((ws: WebSocket): void => {
    const queue = inputQueueRef.current;
    for (const chunk of queue.chunks) ws.send(chunk);
    queue.chunks = [];
    queue.bytes = 0;
  }, []);

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
    let cleanup: () => void = () => {};

    /**
     * xterm bakes glyph metrics at open(); if the bundled webfont has not
     * loaded yet it measures the fallback and columns/cursor drift. Boot
     * once the font is measurable, capped at 1.5s so a cold cache never
     * stalls the terminal.
     */
    const bootWhenFontReady = (start: () => void): void => {
      if (!("fonts" in document) || document.fonts.check('13px "JetBrains Mono"')) {
        start();
        return;
      }
      void Promise.race([
        Promise.all([
          document.fonts.load('13px "JetBrains Mono"'),
          document.fonts.load('700 13px "JetBrains Mono"'),
        ]),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]).then(() => {
        if (!disposed) start();
      });
    };

    bootWhenFontReady(() => {
      let attempt = 0;
      let reconnectTimer: number | null = null;
      let remoteEnded = false;
      // Last time the server proved liveness (pong). A half-open socket —
      // slept laptop, NAT eviction — never fires close, so staleness here
      // is the only signal the peer is gone.
      let lastPongAt = Date.now();

      const termTheme = readTerminalTheme();
      const term = new Terminal({
        cursorBlink: true,
        // Read at creation only; later changes apply live in the refit
        // effect below, which avoids tearing down the Terminal and its WS.
        fontSize: useUi.getState().fontSize,
        fontFamily: readMonoFontStack(),
        scrollback,
        theme: termTheme,
        // Alt+click moves the readline cursor via arrow keys (no shell
        // integration needed) — a VS Code terminal affordance
        altClickMovesCursor: true,
        // Unicode11Addon relies on the proposed unicode API
        allowProposedApi: true,
      });
      termRef.current = term;
      const fitAddon = new FitAddon();
      fitRef.current = fitAddon;
      const searchTheme = {
        matchBackground: termTheme.searchMatch,
        matchOverviewRuler: termTheme.searchMatch,
        activeMatchBackground: termTheme.searchActive,
        activeMatchColorOverviewRuler: termTheme.searchActive,
      };
      const searchOptions: ISearchOptions = { decorations: searchTheme };
      searchOptionsRef.current = searchOptions;
      const searchAddon = new SearchAddon();
      searchRef.current = searchAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.open(container);
      // GPU renderer (the VS Code smoothness default); fall back to the DOM
      // renderer when WebGL is unavailable or the context dies.
      try {
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        webgl.onContextLoss(() => webgl.dispose());
      } catch {
        // no WebGL in this browser — DOM renderer it is
      }

      // Buffered pane: the web terminal renders into the MAIN buffer so the
      // transcript accumulates in local scrollback and scrolls natively.
      // The primary mechanism is server-side: tmux runs with smcup/rmcup
      // removed (tmux.ts overrides), so the pane is never wrapped in the
      // alternate screen and pane scrolling reaches us as LF scrolling.
      // This strip is the fallback for servers without that override: if a
      // DECSET 1049 still arrives (tmux wrap), it is swallowed so the pane
      // still renders into the main buffer — though without the override
      // tmux's CSI-S scrolling means nothing accumulates. The app's 1049
      // requests are remembered: a full-screen app (vim, less, codex, Claude
      // Code's alternate views) owns the viewport, so wheel input is sent
      // through as arrow keys — the app's own internal scrolling (iTerm2
      // alternate-scroll semantics). Most such apps never set DECSET 1007.
      // Mouse reporting (1000/1002/1003/1006/1015) stays swallowed so plain
      // drag remains a native browser selection.
      let appAlt = false;
      const privateModes = (set: boolean) => (params: (number | number[])[]): boolean => {
        let handled = false;
        for (const list of params) {
          for (const p of typeof list === "number" ? [list] : list) {
            if (p === 1049) {
              handled = true; // strip alt-screen switching
              appAlt = set;
            } else if ([1000, 1002, 1003, 1006, 1015].includes(p)) {
              handled = true; // keep drag native
            }
          }
        }
        return handled;
      };
      // "?" in DECSET/DECRST (CSI ? Ps h / CSI ? Ps l) is the private-parameter
      // prefix (0x3c..0x3f), not an intermediate (0x20..0x2f) — passing it as
      // `intermediates` makes xterm throw at registration.
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, privateModes(true));
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, privateModes(false));

      // Off-bottom tracking for the ↓ live pill: every scroll path (native
      // wheel, scrollbar drag, touch, programmatic) funnels through viewport
      // changes, and onScroll recomputes from geometry.
      const syncAtBottom = (): void => {
        const buf = term.buffer.active;
        if (buf.type === "alternate") return;
        const bottom = buf.viewportY >= buf.baseY;
        userPinnedRef.current = !bottom;
        setAtBottom(bottom);
      };
      term.onScroll(() => {
        if (term.buffer.active.type === "alternate") return;
        syncAtBottom();
      });
      term.onSelectionChange(() => {
        setHasSelection(term.hasSelection());
      });

      // Live-follow invariant: xterm only advances the viewport with new
      // output when it already sits at the bottom — one reflow (keyboard
      // open/close, refit during replay) leaves the user stranded mid-
      // history while live streams below. Re-anchor after every parsed
      // write unless the user deliberately scrolled up.
      term.onWriteParsed(() => {
        if (!userPinnedRef.current && term.buffer.active.type !== "alternate") {
          term.scrollToBottom();
        }
      });

      // Scroll intent in "towards history is positive" lines. While a
      // full-screen app owns the viewport the wheel is arrow keys, period —
      // alternate-scroll semantics (iTerm2); local history above its frame
      // is stale and must not swallow the wheel. Otherwise a scrollable
      // buffer scrolls locally — instant, no network — and a quiet plain
      // pane with nothing to scroll skips.
      const scrollIntent = (lines: number): void => {
        if (lines === 0) return;
        if (appAlt) {
          const seq = lines > 0 ? "\x1b[A" : "\x1b[B";
          const n = Math.min(Math.abs(lines), 200);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(encoderRef.current.encode(seq.repeat(n)));
          }
          return;
        }
        const scrollable = term.buffer.active.length > term.rows;
        if (!scrollable) return;
        if (lines > 0) userPinnedRef.current = true;
        term.scrollLines(-lines);
        const buf = term.buffer.active;
        const bottom = buf.viewportY >= buf.baseY;
        if (bottom) userPinnedRef.current = false;
        setAtBottom(bottom);
      };

      // Wheel: the local buffer scrolls natively via scrollLines — the
      // handler exists because xterm 6 does not act on native wheel here.
      // Wheel-up (deltaY < 0) means "towards history". deltaMode 1 (Firefox)
      // reports lines, not pixels.
      let wheelAccum = 0;
      let wheelTimer: number | null = null;
      const flushWheel = () => {
        wheelTimer = null;
        const lines = Math.max(-40, Math.min(40, Math.round(wheelAccum)));
        wheelAccum = 0;
        scrollIntent(lines);
      };
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.deltaMode === 1 ? event.deltaY : event.deltaY / 18;
        wheelAccum -= delta;
        if (wheelTimer === null) {
          wheelTimer = window.setTimeout(flushWheel, 90);
        }
      };
      container.addEventListener("wheel", onWheel, { passive: false, capture: true });

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

      // Paste gate (VS Code-style): multi-line clipboard content is executed
      // line by line by the shell, so it needs explicit confirmation.
      const gatePaste = (text: string): void => {
        if (!text) return;
        if (!text.includes("\n")) {
          term.paste(text);
          return;
        }
        pendingPasteRef.current = text;
        setPasteConfirmation({ lines: text.split("\n").length });
      };
      const readAndGate = (): void => {
        void navigator.clipboard
          .readText()
          .then(gatePaste)
          .catch(() => {
            toast("Paste blocked by the browser — allow clipboard access for this site", "error");
          });
      };

      // Right-click = paste (PuTTY style) — pointer devices only. On touch,
      // long-press must reach xterm's own touch-selection gesture; the key
      // row carries paste there anyway.
      const contextMenu = (event: MouseEvent) => {
        event.preventDefault();
        readAndGate();
      };
      if (!window.matchMedia("(hover: none)").matches) {
        container.addEventListener("contextmenu", contextMenu, true);
      }

      // Touch selection: xterm 6 has none. A long-press (>500ms, <10px drift)
      // selects the cell under the finger, dragging extends it (panning is
      // blocked only while a selection drag is active — a plain swipe keeps
      // native scrolling), and releasing copies, mirroring the mouse
      // copy-on-release. All display-layer cell math.
      let touchStart: { x: number; y: number; at: number } | null = null;
      let touchAnchor: { col: number; row: number } | null = null;
      let touchTimer: number | null = null;
      let lastSwipeY: number | null = null;
      let swipeAccum = 0;
      // Momentum: a finger release keeps scrolling with decaying velocity —
      // the gesture feel of native scrollviews, riding the same channel.
      // Only samples the swipe path; a selection drag or a second finger
      // cancels it.
      const flingSamples: Array<{ t: number; y: number }> = [];
      let flingTimer: number | null = null;
      const stopFling = () => {
        if (flingTimer !== null) {
          window.clearInterval(flingTimer);
          flingTimer = null;
        }
      };
      const pixelPerLine = (): number => {
        const screenEl = container.querySelector(".xterm-screen");
        if (!screenEl || term.rows === 0) return 0;
        const h = screenEl.getBoundingClientRect().height;
        return h === 0 ? 0 : h / term.rows;
      };
      // 60Hz-ish ticks, exponential decay, hard cap. Positive velocity =
      // finger dragged down = into history (matches the drag accumulation).
      const FLING_TICK_MS = 32;
      const startFling = (vLinesPerMs: number) => {
        stopFling();
        let v = vLinesPerMs;
        let frac = 0;
        let budget = 120;
        flingTimer = window.setInterval(() => {
          frac += v * FLING_TICK_MS;
          const lines = Math.trunc(frac);
          if (lines !== 0) {
            frac -= lines;
            budget -= Math.abs(lines);
            scrollIntent(lines);
          }
          v *= 0.9;
          if (Math.abs(v * FLING_TICK_MS) < 0.1 || budget <= 0) stopFling();
        }, FLING_TICK_MS);
      };
      const cellAt = (x: number, y: number) => {
        const screenEl = container.querySelector(".xterm-screen");
        if (!screenEl || term.cols === 0 || term.rows === 0) return null;
        const r = screenEl.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const col = Math.floor(((x - r.left) / r.width) * term.cols);
        const row = Math.floor(((y - r.top) / r.height) * term.rows);
        return {
          col: Math.max(0, Math.min(term.cols - 1, col)),
          screenRow: Math.max(0, Math.min(term.rows - 1, row)),
        };
      };
      const applyTouchSelection = (cur: { col: number; screenRow: number }) => {
        if (!touchAnchor) return;
        // select() takes absolute buffer rows (viewport row + scroll offset)
        const a = touchAnchor.row;
        const b = cur.screenRow;
        const cols = term.cols;
        if (b > a || (b === a && cur.col >= touchAnchor.col)) {
          term.select(touchAnchor.col, a, (b - a) * cols + cur.col - touchAnchor.col + 1);
        } else {
          term.select(cur.col, b, (a - b) * cols + touchAnchor.col - cur.col + 1);
        }
      };

      const onTouchStart = (event: TouchEvent) => {
        stopFling();
        flingSamples.length = 0;
        const first = event.touches[0];
        if (!first || event.touches.length !== 1) return;
        const t = first;
        touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
        lastSwipeY = null;
        swipeAccum = 0;
        const cell = cellAt(t.clientX, t.clientY);
        if (!cell) return;
        touchAnchor = null;
        if (touchTimer !== null) window.clearTimeout(touchTimer);
        touchTimer = window.setTimeout(() => {
          touchTimer = null;
          if (!touchStart) return;
          touchAnchor = { col: cell.col, row: cell.screenRow };
          term.select(cell.col, cell.screenRow, 1);
        }, 500);
      };
      const onTouchMove = (event: TouchEvent) => {
        const first = event.touches[0];
        if (!touchStart || !first || event.touches.length !== 1) return;
        const t = first;
        const drift = Math.abs(t.clientX - touchStart.x) + Math.abs(t.clientY - touchStart.y);
        if (touchTimer !== null && drift > 10) {
          window.clearTimeout(touchTimer);
          touchTimer = null;
        }
        if (!touchAnchor) {
          // No selection drag: the swipe scrolls the local buffer through
          // the same scrollIntent as the wheel — content-follows-finger,
          // with the xterm viewport as the only scroller.
          const screenEl = container.querySelector(".xterm-screen");
          if (!screenEl) return;
          const r = screenEl.getBoundingClientRect();
          if (r.height === 0 || term.rows === 0) return;
          event.preventDefault();
          const lineH = r.height / term.rows;
          flingSamples.push({ t: Date.now(), y: t.clientY });
          if (flingSamples.length > 10) flingSamples.shift();
          if (lastSwipeY !== null) {
            // Touch is content-follows-finger, the inverse of the desktop
            // wheel: dragging DOWN pulls earlier lines into view (scroll-up
            // on the channel), dragging UP returns towards live.
            swipeAccum += (t.clientY - lastSwipeY) / lineH;
            const lines = Math.trunc(swipeAccum);
            if (lines !== 0) {
              swipeAccum -= lines;
              scrollIntent(lines);
            }
          }
          lastSwipeY = t.clientY;
          return;
        }
        // a selection drag owns the gesture — panning would fight it
        event.preventDefault();
        const cur = cellAt(t.clientX, t.clientY);
        if (cur) applyTouchSelection(cur);
      };
      const onTouchEnd = () => {
        lastSwipeY = null;
        swipeAccum = 0;
        if (touchTimer !== null) {
          window.clearTimeout(touchTimer);
          touchTimer = null;
        }
        if (touchAnchor) {
          // Selection stays on screen after release — copying is an explicit
          // Ctrl+C / key-row action, never a silent side effect.
        } else {
          if (touchStart && Date.now() - touchStart.at < 300) {
            term.clearSelection();
          }
          // Release velocity decides whether the swipe keeps moving: the
          // momentum tail of a flick continues over the same channel.
          const last = flingSamples[flingSamples.length - 1];
          if (last) {
            let first = last;
            const now = Date.now();
            for (const s of flingSamples) {
              if (now - s.t <= 120) {
                first = s;
                break;
              }
            }
            const dt = last.t - first.t;
            const pxl = pixelPerLine();
            if (dt >= 16 && pxl > 0) {
              // Finger dragged DOWN => positive velocity => into history.
              const vLines = (last.y - first.y) / dt / pxl;
              if (Math.abs(vLines) > 0.05) startFling(vLines);
            }
          }
        }
        flingSamples.length = 0;
        touchStart = null;
        touchAnchor = null;
      };
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
      container.addEventListener("touchend", onTouchEnd, true);

      // Web-style copy: Ctrl+C copies when a selection exists and otherwise
      // falls through to the shell as SIGINT — the key decides by state,
      // never stealing the interrupt. Ctrl+Shift+C is the unconditional
      // fallback (terminal habit). The selection survives copying.
      const copySelectionNow = (): boolean => {
        if (!term.hasSelection()) return false;
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {
          // clipboard permission denied
        });
        return true;
      };
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        if (matchesBinding(event, KEYBINDINGS.terminalSearch)) {
          setSearchOpen(true);
          return false;
        }
        if (matchesBinding(event, KEYBINDINGS.terminalCopy) && copySelectionNow()) {
          return false;
        }
        if (matchesBinding(event, KEYBINDINGS.terminalCopyShift)) {
          copySelectionNow();
          return false;
        }
        if (
          matchesBinding(event, KEYBINDINGS.terminalPaste) ||
          matchesBinding(event, KEYBINDINGS.terminalPasteShift)
        ) {
          readAndGate();
          return false;
        }
        if (matchesBinding(event, KEYBINDINGS.terminalBottom)) {
          term.scrollToBottom();
          return false;
        }
        if (matchesBinding(event, KEYBINDINGS.terminalPageUp)) {
          term.scrollPages(-1);
          return false;
        }
        if (matchesBinding(event, KEYBINDINGS.terminalPageDown)) {
          term.scrollPages(1);
          return false;
        }
        return true;
      });
      term.onData((data) => {
        // Sticky mobile Ctrl (soft keyboards have no Ctrl key): the next
        // single character is sent as its control code — a-z fold to
        // 0x01–0x1a, space and @[\]^_ follow ASCII caret notation. Any
        // other input disarms and passes through untouched.
        let payload = data;
        if (ctrlArmedRef.current) {
          ctrlArmedRef.current = false;
          setCtrlArmedState(false);
          if (data.length === 1) {
            const code = data.charCodeAt(0);
            const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
            const isCaretPunct = code === 0x20 || (code >= 0x40 && code <= 0x5f);
            if (isLetter || isCaretPunct) {
              payload = String.fromCharCode(code & 0x1f);
            }
          }
        }
        const bytes = encoderRef.current.encode(payload);
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(bytes);
        } else {
          // Socket down (connecting, reconnecting, or a half-open peer):
          // queue it — dropping input silently loses commands and half-
          // typed lines exactly when the user is trying to recover.
          queueInput(bytes);
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
          lastPongAt = Date.now();
          setStatus("connected");
          doFit();
          // scrollback tells the server how deep the connect-time history
          // seed should reach (D7) — it must match this terminal's buffer.
          ws.send(
            JSON.stringify({ type: "init", cols: term.cols, rows: term.rows, scrollback }),
          );
          // Anything typed while the socket was down goes now, after the
          // geometry frame so the server has the right size for it.
          flushInputQueue(ws);
        };
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(event.data));
            return;
          }
          try {
            const message = JSON.parse(String(event.data)) as {
              type?: string;
              active?: boolean;
            };
            if (message.type === "taken-over") {
              setStatus("taken-over");
            } else if (message.type === "ended") {
              remoteEnded = true;
              setStatus("ended");
            } else if (message.type === "pong") {
              lastPongAt = Date.now();
            } else if (message.type === "seed-start") {
              // A connect-time history seed follows. Every attach re-seeds
              // from tmux, so the local transcript is replaced, not
              // extended: appending the seed to a buffer that already
              // holds the same history would duplicate the scrollback.
              // (A first connect resets an empty buffer — a no-op.)
              term.reset();
            }
          } catch {
            // non-JSON control frame
          }
        };
        ws.onclose = (event) => {
          // Only the current socket may clear the ref. A superseded
          // socket's close event arrives after its replacement is live
          // (terminal rebuild, retry); nulling the ref then would
          // silently kill every input path on a healthy connection.
          if (wsRef.current === ws) wsRef.current = null;
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
      // Keepalive: proxied paths (Cloudflare) drop idle WebSockets after
      // ~100s, and every drop used to cost a reconnect. The server pongs.
      // Three unanswered pings mean the peer is gone (half-open socket),
      // which never fires close on its own — drop it and let the reconnect
      // path take over instead of typing into a dead connection.
      const PING_INTERVAL_MS = 25000;
      const pingTimer = window.setInterval(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt > 3 * PING_INTERVAL_MS) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
      term.focus();
      connect();

      cleanup = () => {
        disposed = true;
        stopFling();
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        container.removeEventListener("contextmenu", contextMenu, true);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd, true);
        container.removeEventListener("wheel", onWheel, { capture: true });
        if (wheelTimer !== null) window.clearTimeout(wheelTimer);
        observer.disconnect();
        unsubscribeTheme();
        window.clearInterval(pingTimer);
        wsRef.current?.close();
        term.dispose();
        termRef.current = null;
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
    // scrollback changes require a fresh Terminal instance; fontSize must not
    // be here — it applies live below, without dropping the PTY
  }, [path, nonce, scrollback, sendResize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      // container not laid out yet
    }
    sendResize();
  }, [fontSize, sendResize]);

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);

  const historyPage = useCallback(() => {
    termRef.current?.scrollPages(-1);
  }, []);

  const sendText = useCallback((text: string) => {
    const bytes = encoderRef.current.encode(text);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(bytes);
    } else {
      queueInput(bytes);
    }
  }, [queueInput]);

  const setCtrlArmed = useCallback((value: boolean) => {
    ctrlArmedRef.current = value;
    setCtrlArmedState(value);
  }, []);

  const paste = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        if (!text.includes("\n")) {
          termRef.current?.paste(text);
          return;
        }
        pendingPasteRef.current = text;
        setPasteConfirmation({ lines: text.split("\n").length });
      })
      .catch(() => {
        // clipboard permission denied
      });
  }, []);

  const confirmPaste = useCallback(() => {
    const text = pendingPasteRef.current;
    pendingPasteRef.current = null;
    setPasteConfirmation(null);
    if (text) termRef.current?.paste(text);
  }, []);

  const cancelPaste = useCallback(() => {
    pendingPasteRef.current = null;
    setPasteConfirmation(null);
  }, []);

  const clearSelection = useCallback(() => {
    termRef.current?.clearSelection();
  }, []);

  const copySelection = useCallback(() => {
    const selection = termRef.current?.getSelection();
    if (!selection) return;
    void navigator.clipboard.writeText(selection).catch(() => {
      // clipboard permission denied
    });
  }, []);

  const findNext = useCallback((term?: string) => {
    const search = searchRef.current;
    if (!search || term === undefined || term.length === 0) return;
    search.findNext(term, searchOptionsRef.current ?? undefined);
  }, []);
  const findPrevious = useCallback((term?: string) => {
    const search = searchRef.current;
    if (!search || term === undefined || term.length === 0) return;
    search.findPrevious(term, searchOptionsRef.current ?? undefined);
  }, []);

  const goLive = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    userPinnedRef.current = false;
    term.scrollToBottom();
    setAtBottom(true);
  }, []);

  return {
    containerRef,
    status,
    atBottom,
    hasSelection,
    goLive,
    reconnect,
    sendText,
    ctrlArmed,
    setCtrlArmed,
    historyPage,
    paste,
    pasteConfirmation,
    confirmPaste,
    cancelPaste,
    copySelection,
    clearSelection,
    fit,
    searchOpen,
    setSearchOpen,
    findNext,
    findPrevious,
  };
}
