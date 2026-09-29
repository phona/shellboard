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
};

export class ActivityTracker {
  private readonly bus: EventBus;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly tmuxInfos = new Map<string, TmuxSessionInfo | null>();
  private readonly attached = new Map<string, boolean>();
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
  seed(sessionId: string): void {
    if (!this.runtimes.has(sessionId)) {
      this.tmuxInfos.set(sessionId, null);
      this.attached.set(sessionId, false);
      this.recompute(sessionId);
    }
  }

  drop(sessionId: string): void {
    this.runtimes.delete(sessionId);
    this.tmuxInfos.delete(sessionId);
    this.attached.delete(sessionId);
  }

  /** tmux-observed fact (activity, liveness). */
  observe(sessionId: string, info: TmuxSessionInfo | null): void {
    if (!this.runtimes.has(sessionId)) this.seed(sessionId);
    this.tmuxInfos.set(sessionId, info);
    this.recompute(sessionId);
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
    const next: SessionRuntime = {
      sessionId,
      alive: info !== null,
      attachedClients: this.attached.get(sessionId) ? 1 : 0,
      lastActivityAt: derivation.lastActivityAt,
      activity: derivation.activity,
    };
    this.runtimes.set(sessionId, next);
    const changed =
      !prev ||
      prev.alive !== next.alive ||
      prev.activity !== next.activity ||
      prev.attachedClients !== next.attachedClients;
    if (changed) {
      this.bus.publish({ type: "session.activity", runtime: next });
      if (prev) this.transitionListener?.(sessionId, prev, next);
    }
  }
}
