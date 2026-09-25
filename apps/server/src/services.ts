import type { ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db/db.js";
import { TmuxService } from "./tmux/tmux.js";
import { EventBus } from "./events/bus.js";
import { ActivityTracker } from "./activity/tracker.js";
import { ActivityObserver } from "./activity/observer.js";
import { ProjectService } from "./projects/projectService.js";
import { SessionService } from "./sessions/sessionService.js";
import { TerminalBridge } from "./terminal/bridge.js";
import { ToolTerminalManager } from "./terminal/toolTerminal.js";
import { GitService } from "./git/gitService.js";
import { FileService } from "./files/fileService.js";

export interface Services {
  config: ServerConfig;
  db: Db;
  tmux: TmuxService;
  bus: EventBus;
  tracker: ActivityTracker;
  observer: ActivityObserver;
  projects: ProjectService;
  sessions: SessionService;
  bridge: TerminalBridge;
  tools: ToolTerminalManager;
  git: GitService;
  files: FileService;
}

export function buildServices(config: ServerConfig): Services {
  const db = openDatabase(config.dbPath);
  const tmux = new TmuxService(config.tmuxSocket);
  const bus = new EventBus();
  const tracker = new ActivityTracker(bus);
  const observer = new ActivityObserver(db, tmux, tracker);
  const projects = new ProjectService(db);
  const sessions = new SessionService(db, projects, tmux, tracker, bus);
  return {
    config,
    db,
    tmux,
    bus,
    tracker,
    observer,
    projects,
    sessions,
    bridge: new TerminalBridge(config.tmuxSocket, tracker),
    tools: new ToolTerminalManager(),
    git: new GitService(),
    files: new FileService(),
  };
}
