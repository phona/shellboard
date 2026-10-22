import path from "node:path";
import type { ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db/db.js";
import { TmuxService } from "./tmux/tmux.js";
import { EventBus } from "./events/bus.js";
import { ActivityTracker } from "./activity/tracker.js";
import { ActivityObserver } from "./activity/observer.js";
import { ProjectService } from "./projects/projectService.js";
import { CommandService } from "./sessions/commandService.js";
import { SessionService } from "./sessions/sessionService.js";
import { TerminalBridge } from "./terminal/bridge.js";
import { ToolTerminalManager } from "./terminal/toolTerminal.js";
import { GitService } from "./git/gitService.js";
import { FileService } from "./files/fileService.js";
import { UploadService } from "./uploads/uploadService.js";
import { NotifyService } from "./notify/notifyService.js";
import { SshService } from "./ssh/ssh.js";

export interface Services {
  config: ServerConfig;
  db: Db;
  tmux: TmuxService;
  ssh: SshService;
  bus: EventBus;
  tracker: ActivityTracker;
  observer: ActivityObserver;
  projects: ProjectService;
  sessions: SessionService;
  commands: CommandService;
  bridge: TerminalBridge;
  tools: ToolTerminalManager;
  git: GitService;
  files: FileService;
  uploads: UploadService;
  notifier: NotifyService;
}

export function buildServices(config: ServerConfig): Services {
  const db = openDatabase(config.dbPath);
  const tmux = new TmuxService(config.tmuxSocket);
  const ssh = new SshService(
    {
      connectTimeoutSeconds: config.sshConnectTimeoutSeconds,
      serverAliveIntervalSeconds: config.sshServerAliveIntervalSeconds,
      serverAliveCountMax: config.sshServerAliveCountMax,
    },
    config.homeDir,
  );
  const bus = new EventBus();
  const tracker = new ActivityTracker(bus);
  const observer = new ActivityObserver(db, tmux, tracker);
  const projects = new ProjectService(db);
  const uploads = new UploadService(path.join(config.homeDir, "uploads"));
  const sessions = new SessionService(db, projects, tmux, tracker, bus, uploads, ssh);
  const commands = new CommandService(db);
  const notifier = new NotifyService(config, tmux, sessions, bus);
  // state-driven notify (D8): activity transitions feed the hook fan-out
  tracker.setTransitionListener((sessionId, prev, next) => {
    notifier.handleActivityTransition(sessionId, prev, next);
  });
  return {
    config,
    db,
    tmux,
    ssh,
    bus,
    tracker,
    observer,
    projects,
    sessions,
    commands,
    bridge: new TerminalBridge(config.tmuxSocket, tracker, tmux, ssh.localRuntimeCwd),
    tools: new ToolTerminalManager(),
    git: new GitService(),
    files: new FileService(),
    uploads,
    notifier,
  };
}
