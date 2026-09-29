import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NotifyInput, NotifySessionInfo, Session, WsEvent } from "@shellboard/contracts";
import type { ServerConfig } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { processEnv } from "../env.js";
import type { SessionService } from "../sessions/sessionService.js";
import type { TmuxService } from "../tmux/tmux.js";

export type NotifyEvent = Extract<WsEvent, { type: "session.notify" }>;

export interface NotifyResult {
  session: NotifySessionInfo | null;
  /** Settles when every hook run finished; outcomes are logged, never thrown. */
  hooks: Promise<void>;
}

const HOOK_FILE = /\.m?js$/;
const MAX_HOOK_STDERR = 4096;
const MAX_LOGGED_STDERR = 500;

export class NotifyService {
  private readonly config: ServerConfig;
  private readonly tmux: TmuxService;
  private readonly sessions: SessionService;
  private readonly bus: EventBus;

  constructor(
    config: ServerConfig,
    tmux: TmuxService,
    sessions: SessionService,
    bus: EventBus,
  ) {
    this.config = config;
    this.tmux = tmux;
    this.sessions = sessions;
    this.bus = bus;
  }

  async notify(input: NotifyInput): Promise<NotifyResult> {
    const session = await this.resolveSession(input);
    const event: NotifyEvent = {
      type: "session.notify",
      title: input.title,
      body: input.body ?? null,
      level: input.level,
      at: Date.now(),
      session,
    };
    this.bus.publish(event);
    return { session, hooks: this.runHooks(event) };
  }

  /**
   * Attribution only: the event may name the session explicitly, or carry a
   * tmux pane id (TMUX_PANE, set by tmux for every process inside a pane).
   * Both resolve via tmux/DB lookups — no terminal bytes involved. An event
   * that cannot be attributed still notifies, with session: null.
   */
  private async resolveSession(input: NotifyInput): Promise<NotifySessionInfo | null> {
    let session: Session | undefined;
    if (input.sessionId) {
      try {
        session = this.sessions.get(input.sessionId);
      } catch {
        session = undefined;
      }
    } else if (input.pane) {
      const tmuxName = await this.tmux.sessionNameForPane(input.pane);
      if (tmuxName) session = this.sessions.findByTmuxName(tmuxName);
    }
    if (!session) return null;
    return { id: session.id, name: session.name, agentType: session.agentType, cwd: session.cwd };
  }

  /**
   * Runs every user hook in config.notifyHooksDir. This directory is the
   * whole execution boundary (D8): only files the user put here ever run,
   * and a notify event can never choose what runs — it is not a generic exec
   * endpoint. Each hook is a child process (crash-isolated, re-read from disk
   * per event, so edits apply immediately); the payload is the same
   * `session.notify` event the web UI receives, written to stdin.
   */
  private runHooks(event: NotifyEvent): Promise<void> {
    const dir = this.config.notifyHooksDir;
    return (async () => {
      let names: string[];
      try {
        names = (await fs.promises.readdir(dir)).filter(isHookFileName).sort();
      } catch {
        return; // no hooks directory yet — nothing to run
      }
      const payload = JSON.stringify(event);
      await Promise.all(
        names.map((name) => this.runHook(path.join(dir, name), name, event, payload)),
      );
    })();
  }

  private runHook(file: string, name: string, event: NotifyEvent, payload: string): Promise<void> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file], {
        // hooks run against the session's worktree so git/fs one-liners work
        cwd: event.session ? event.session.cwd : this.config.homeDir,
        env: {
          ...processEnv(),
          SHELLBOARD_SESSION_ID: event.session?.id ?? "",
          SHELLBOARD_SESSION_NAME: event.session?.name ?? "",
          SHELLBOARD_SESSION_CWD: event.session?.cwd ?? "",
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      let timedOut = false;
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_HOOK_STDERR) stderr += chunk.toString("utf8");
      });
      // a hook may exit without draining stdin — swallow the EPIPE
      child.stdin?.on("error", () => {});
      child.stdin?.end(payload);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.config.notifyHookTimeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        console.warn(`[notify] hook ${name} failed to start: ${err.message}`);
        resolve();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, MAX_LOGGED_STDERR)}` : "";
        if (timedOut) {
          console.warn(`[notify] hook ${name} killed after timeout (${ms}ms)${detail}`);
        } else if (code === 0) {
          console.log(`[notify] hook ${name} ok (${ms}ms)`);
        } else {
          console.warn(`[notify] hook ${name} exit ${code ?? "signal"} (${ms}ms)${detail}`);
        }
        resolve();
      });
    });
  }
}

function isHookFileName(name: string): boolean {
  return !name.startsWith(".") && !name.includes(".disabled.") && HOOK_FILE.test(name);
}
