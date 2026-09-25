import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { AGENT_DEFAULT_COMMAND } from "@shellboard/contracts";
import type {
  CreateSessionInput,
  Session,
  SessionWithRuntime,
  UpdateSessionInput,
} from "@shellboard/contracts";
import type { Db } from "../db/db.js";
import { httpError } from "../errors.js";
import { newId } from "../ids.js";
import { defaultShell } from "../env.js";
import type { TmuxService } from "../tmux/tmux.js";
import type { ActivityTracker } from "../activity/tracker.js";
import type { EventBus } from "../events/bus.js";
import type { ProjectService } from "../projects/projectService.js";

interface SessionRow {
  id: string;
  project_id: string;
  name: string;
  cwd: string;
  agent_type: string;
  command: string;
  tmux_name: string;
  created_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    cwd: row.cwd,
    agentType: row.agent_type as Session["agentType"],
    command: JSON.parse(row.command) as string[],
    tmuxName: row.tmux_name,
    createdAt: row.created_at,
  };
}

async function commandExists(binary: string): Promise<boolean> {
  const result = await execa("which", [binary], { reject: false });
  return result.exitCode === 0;
}

function resolveCommand(input: CreateSessionInput): string[] {
  if (input.agentType === "shell") return [defaultShell()];
  if (input.agentType === "custom") {
    const raw = (input.command ?? "").trim();
    if (!raw) throw httpError(400, "custom agent requires a command");
    return raw.split(/\s+/);
  }
  const command = AGENT_DEFAULT_COMMAND[input.agentType];
  if (!command) throw httpError(400, `unsupported agent type: ${input.agentType}`);
  return [command];
}

export class SessionService {
  private readonly db: Db;
  private readonly projects: ProjectService;
  private readonly tmux: TmuxService;
  private readonly tracker: ActivityTracker;
  private readonly bus: EventBus;

  constructor(
    db: Db,
    projects: ProjectService,
    tmux: TmuxService,
    tracker: ActivityTracker,
    bus: EventBus,
  ) {
    this.db = db;
    this.projects = projects;
    this.tmux = tmux;
    this.tracker = tracker;
    this.bus = bus;
  }

  list(): SessionWithRuntime[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at")
      .all() as SessionRow[];
    return rows.map((row) => {
      const session = toSession(row);
      return { session, runtime: this.tracker.get(session.id) };
    });
  }

  get(id: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    if (!row) throw httpError(404, "session not found");
    return toSession(row);
  }

  getWithRuntime(id: string): SessionWithRuntime {
    const session = this.get(id);
    return { session, runtime: this.tracker.get(session.id) };
  }

  async create(input: CreateSessionInput): Promise<SessionWithRuntime> {
    const project = this.projects.get(input.projectId);
    const cwd = (input.cwd ?? "").trim() || project.rootPath;
    if (!path.isAbsolute(cwd)) throw httpError(400, `cwd must be absolute: ${cwd}`);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw httpError(400, `cwd is not a directory: ${cwd}`);
    }
    const command = resolveCommand(input);
    if (!(await commandExists(command[0] ?? ""))) {
      throw httpError(400, `\`${command[0]}\` not found in PATH`);
    }
    const session: Session = {
      id: newId("s"),
      projectId: project.id,
      name: input.name,
      cwd,
      agentType: input.agentType,
      command,
      tmuxName: newId("sb"),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.tmux.newSession(session.tmuxName, cwd, command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw httpError(500, `tmux new-session failed: ${message}`);
    }
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, name, cwd, agent_type, command, tmux_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.projectId,
        session.name,
        session.cwd,
        session.agentType,
        JSON.stringify(session.command),
        session.tmuxName,
        session.createdAt,
      );
    this.tracker.seed(session.id);
    this.bus.publish({ type: "session.created", session });
    return { session, runtime: this.tracker.get(session.id) };
  }

  async restart(id: string): Promise<SessionWithRuntime> {
    const session = this.get(id);
    await this.tmux.killSession(session.tmuxName);
    try {
      await this.tmux.newSession(session.tmuxName, session.cwd, session.command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw httpError(500, `tmux new-session failed: ${message}`);
    }
    this.tracker.seed(session.id);
    this.bus.publish({ type: "session.updated", session });
    return { session, runtime: this.tracker.get(session.id) };
  }

  async rename(id: string, patch: UpdateSessionInput): Promise<Session> {
    const session = this.get(id);
    const name = patch.name ?? session.name;
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
    const updated = this.get(id);
    this.bus.publish({ type: "session.updated", session: updated });
    return updated;
  }

  async kill(id: string): Promise<void> {
    const session = this.get(id);
    await this.tmux.killSession(session.tmuxName);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.tracker.drop(id);
    this.bus.publish({ type: "session.deleted", sessionId: id });
  }
}
