import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { AGENT_DEFAULT_COMMAND } from "@shellboard/contracts";
import type {
  CreateSessionInput,
  EnvVarMap,
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
import type { UploadService } from "../uploads/uploadService.js";
import { isWindowsAbsolutePath } from "../ssh/ssh.js";
import type { SshService } from "../ssh/ssh.js";

interface SessionRow {
  id: string;
  project_id: string;
  name: string;
  cwd: string;
  agent_type: string;
  command: string;
  env: string;
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
    env: parseEnv(row.env),
    tmuxName: row.tmux_name,
    createdAt: row.created_at,
  };
}

/** Rows written before the env column existed (migration default `{}`) and any
    hand-edited row read back as an empty map rather than failing the whole
    list. */
function parseEnv(raw: string): EnvVarMap {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as EnvVarMap;
    }
    return {};
  } catch {
    return {};
  }
}

async function commandExists(binary: string): Promise<boolean> {
  const result = await execa("which", [binary], { reject: false });
  return result.exitCode === 0;
}

function resolveCommand(input: CreateSessionInput, remote: boolean): string[] {
  if (input.agentType === "shell") return [remote ? "powershell.exe" : defaultShell()];
  if (input.agentType === "custom") {
    const raw = (input.command ?? "").trim();
    if (!raw) throw httpError(400, "custom agent requires a command");
    return raw.split(/\s+/);
  }
  const command = AGENT_DEFAULT_COMMAND[input.agentType];
  if (!command) throw httpError(400, `unsupported agent type: ${input.agentType}`);
  return [...command];
}

export class SessionService {
  private readonly db: Db;
  private readonly projects: ProjectService;
  private readonly tmux: TmuxService;
  private readonly tracker: ActivityTracker;
  private readonly bus: EventBus;
  private readonly uploads: UploadService;
  private readonly ssh: SshService;

  constructor(
    db: Db,
    projects: ProjectService,
    tmux: TmuxService,
    tracker: ActivityTracker,
    bus: EventBus,
    uploads: UploadService,
    ssh: SshService,
  ) {
    this.db = db;
    this.projects = projects;
    this.tmux = tmux;
    this.tracker = tracker;
    this.bus = bus;
    this.uploads = uploads;
    this.ssh = ssh;
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

  /** tmuxName is immutable, so it is a stable join key for notify events. */
  findByTmuxName(tmuxName: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE tmux_name = ?").get(tmuxName) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  getWithRuntime(id: string): SessionWithRuntime {
    const session = this.get(id);
    return { session, runtime: this.tracker.get(session.id) };
  }

  isRemote(id: string): boolean {
    const session = this.get(id);
    return this.projects.get(session.projectId).location.kind === "ssh";
  }

  async create(input: CreateSessionInput): Promise<SessionWithRuntime> {
    const project = this.projects.get(input.projectId);
    const cwd = (input.cwd ?? "").trim() || project.rootPath;
    if (project.location.kind === "ssh") {
      if (!isWindowsAbsolutePath(cwd)) throw httpError(400, `cwd must be an absolute Windows path: ${cwd}`);
    } else {
      if (!path.isAbsolute(cwd)) throw httpError(400, `cwd must be absolute: ${cwd}`);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw httpError(400, `cwd is not a directory: ${cwd}`);
      }
    }
    const command = resolveCommand(input, project.location.kind === "ssh");
    if (project.location.kind === "local" && !(await commandExists(command[0] ?? ""))) {
      throw httpError(400, `\`${command[0]}\` not found in PATH`);
    }
    const session: Session = {
      id: newId("s"),
      projectId: project.id,
      name: input.name,
      cwd,
      agentType: input.agentType,
      command,
      env: input.env ?? {},
      tmuxName: newId("sb"),
      createdAt: new Date().toISOString(),
    };
    const launch = project.location.kind === "ssh"
      ? {
          cwd: this.ssh.localRuntimeCwd,
          command: this.ssh.buildAgentCommand(
            project.location,
            cwd,
            command,
            session.env,
            input.agentType === "shell",
          ),
          env: {},
          remainOnExit: true,
        }
      : { cwd, command, env: session.env, remainOnExit: false };
    try {
      await this.tmux.newSession(
        session.tmuxName,
        launch.cwd,
        launch.command,
        launch.env,
        { remainOnExit: launch.remainOnExit },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw httpError(500, `tmux new-session failed: ${message}`);
    }
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, name, cwd, agent_type, command, env, tmux_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.projectId,
        session.name,
        session.cwd,
        session.agentType,
        JSON.stringify(session.command),
        JSON.stringify(session.env),
        session.tmuxName,
        session.createdAt,
      );
    this.tracker.seed(session.id, project.location.kind === "ssh");
    this.bus.publish({ type: "session.created", session });
    return { session, runtime: this.tracker.get(session.id) };
  }

  async restart(id: string): Promise<SessionWithRuntime> {
    const session = this.get(id);
    const project = this.projects.get(session.projectId);
    await this.tmux.killSession(session.tmuxName);
    const launch = project.location.kind === "ssh"
      ? {
          cwd: this.ssh.localRuntimeCwd,
          command: this.ssh.buildAgentCommand(
            project.location,
            session.cwd,
            session.command,
            session.env,
            session.agentType === "shell",
          ),
          env: {},
          remainOnExit: true,
        }
      : { cwd: session.cwd, command: session.command, env: session.env, remainOnExit: false };
    try {
      // The pane is recreated from scratch, so the stored launch env has to be
      // re-applied: without it a restart would silently drop the variables the
      // session was created with (D9).
      await this.tmux.newSession(
        session.tmuxName,
        launch.cwd,
        launch.command,
        launch.env,
        { remainOnExit: launch.remainOnExit },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw httpError(500, `tmux new-session failed: ${message}`);
    }
    this.tracker.reset(session.id, project.location.kind === "ssh");
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
    // the upload buffer belongs to the session — no owner, no file (restart
    // keeps it on purpose: the agent may still reference those paths)
    this.uploads.dropSession(id);
    this.bus.publish({ type: "session.deleted", sessionId: id });
  }
}
