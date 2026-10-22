import type { SessionRuntime } from "@shellboard/contracts";
import type { TmuxSessionInfo } from "../tmux/tmux.js";
import type { EventBus } from "../events/bus.js";
import { deriveActivity } from "./derive.js";

const EMPTY_RUNTIME: SessionRuntime = {
  sessionId: "",
  alive: false,
  attachedClients: 0,
  lastActivityAt: null,
  activity: "exited",
  transport: "unknown",
};

export class ActivityTracker {
  private readonly bus: EventBus;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly tmuxInfos = new Map<string, TmuxSessionInfo | null>();
  private readonly attached = new Map<string, boolean>();
  private readonly remote = new Map<string, boolean>();
  private readonly awaitingObservation = new Set<string>();
  /** Server-side consumers of activity transitions (e.g. the idle notify). */
  private transitionListener:
    | ((sessionId: string, prev: SessionRuntime, next: SessionRuntime) => void)
    | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /** Single listener, set once during service wiring. */
  setTransitionListener(
    listener: (sessionId: string, prev: SessionRuntime, next: SessionRuntime) => void,
  ): void {
    this.transitionListener = listener;
  }

  get(sessionId: string): SessionRuntime {
    return this.runtimes.get(sessionId) ?? { ...EMPTY_RUNTIME, sessionId };
  }

  /** Registers a known session so it reports as exited before the first tick. */
  seed(sessionId: string, remote = false): void {
    if (!this.runtimes.has(sessionId)) {
      this.tmuxInfos.set(sessionId, null);
      this.attached.set(sessionId, false);
      this.remote.set(sessionId, remote);
      if (remote) this.awaitingObservation.add(sessionId);
      this.recompute(sessionId);
    }
  }

  /** Clears the previous pane fact after an explicit restart. The next
      observer tick establishes the new tmux/SSH state. */
  reset(sessionId: string, remote = false): void {
    if (!this.runtimes.has(sessionId)) {
      this.seed(sessionId, remote);
      return;
    }
    this.remote.set(sessionId, remote);
    this.tmuxInfos.set(sessionId, null);
    if (remote) this.awaitingObservation.add(sessionId);
    else this.awaitingObservation.delete(sessionId);
    this.recompute(sessionId);
  }

  drop(sessionId: string): void {
    this.runtimes.delete(sessionId);
    this.tmuxInfos.delete(sessionId);
    this.attached.delete(sessionId);
    this.remote.delete(sessionId);
    this.awaitingObservation.delete(sessionId);
  }

  /** tmux-observed fact (activity, liveness). */
  observe(sessionId: string, info: TmuxSessionInfo | null, remote?: boolean): void {
    if (!this.runtimes.has(sessionId)) this.seed(sessionId, remote ?? false);
    if (remote !== undefined) this.remote.set(sessionId, remote);
    this.awaitingObservation.delete(sessionId);
    this.tmuxInfos.set(sessionId, info);
    this.recompute(sessionId);
  }

  /** A failed tmux query is not evidence that the pane or SSH transport ended. */
  markUnknown(sessionId: string, remote: boolean): void {
    if (!this.runtimes.has(sessionId)) this.seed(sessionId, remote);
    this.remote.set(sessionId, remote);
    this.awaitingObservation.delete(sessionId);
    const prev = this.runtimes.get(sessionId);
    if (!prev || prev.transport === "unknown") return;
    const next: SessionRuntime = { ...prev, transport: "unknown" };
    this.runtimes.set(sessionId, next);
    this.bus.publish({ type: "session.activity", runtime: next });
  }

  /** Server-side fact: whether a web PTY is attached (D4, one max). */
  setAttached(sessionId: string, value: boolean): void {
    this.attached.set(sessionId, value);
    this.recompute(sessionId);
  }

  private recompute(sessionId: string): void {
    const prev = this.runtimes.get(sessionId);
    const info = this.tmuxInfos.get(sessionId) ?? null;
    const derivation = deriveActivity(info);
    const isRemote = this.remote.get(sessionId) ?? false;
    const transport = !info
      ? isRemote
        ? this.awaitingObservation.has(sessionId)
          ? "connecting"
          : "unknown"
        : "local"
      : !isRemote
        ? "local"
        : info.paneDead
          ? info.paneExitStatus === 255
            ? "disconnected"
            : "unknown"
          : "connected";
    const next: SessionRuntime = {
      sessionId,
      alive: info !== null,
      attachedClients: this.attached.get(sessionId) ? 1 : 0,
      lastActivityAt: derivation.lastActivityAt,
      activity: derivation.activity,
      transport,
    };
    this.runtimes.set(sessionId, next);
    const changed =
      !prev ||
      prev.alive !== next.alive ||
      prev.activity !== next.activity ||
      prev.attachedClients !== next.attachedClients ||
      prev.transport !== next.transport;
    if (changed) {
      this.bus.publish({ type: "session.activity", runtime: next });
      if (prev) this.transitionListener?.(sessionId, prev, next);
    }
  }
}
