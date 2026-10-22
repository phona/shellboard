import fs from "node:fs";
import path from "node:path";
import {
  SshAuthSchema,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from "@shellboard/contracts";
import type { Db } from "../db/db.js";
import { httpError } from "../errors.js";
import { newId } from "../ids.js";
import { normalizeWindowsPath } from "../ssh/ssh.js";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  location: string;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_username: string | null;
  ssh_auth: string | null;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  if (row.location === "ssh") {
    if (
      row.ssh_host === null ||
      row.ssh_port === null ||
      row.ssh_username === null ||
      row.ssh_auth === null
    ) {
      throw new Error("SSH project has incomplete connection settings");
    }
    const auth = SshAuthSchema.safeParse(JSON.parse(row.ssh_auth));
    if (!auth.success) throw new Error("SSH project has invalid auth settings");
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      location: {
        kind: "ssh",
        host: row.ssh_host,
        port: row.ssh_port,
        username: row.ssh_username,
        auth: auth.data,
      },
      createdAt: row.created_at,
    };
  }
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    location: { kind: "local" },
    createdAt: row.created_at,
  };
}

function normalizeLocation(input: {
  location?: Project["location"];
}): Project["location"] {
  const location: Project["location"] = input.location ?? { kind: "local" };
  if (location.kind === "ssh") {
    if (/[\s\u0000-\u001f\u007f]/.test(location.host)) {
      throw httpError(400, "invalid SSH host");
    }
    if (location.host.startsWith("-")) {
      throw httpError(400, "SSH host must not start with '-'");
    }
    if (/[\s\u0000-\u001f\u007f]/.test(location.username)) {
      throw httpError(400, "invalid SSH username");
    }
    if (!Number.isInteger(location.port) || location.port < 1 || location.port > 65535) {
      throw httpError(400, "invalid SSH port");
    }
    if (location.auth.kind === "key" && location.auth.identityFile !== undefined) {
      if (
        !path.isAbsolute(location.auth.identityFile) ||
        /[\u0000-\u001f\u007f]/.test(location.auth.identityFile)
      ) {
        throw httpError(400, "identityFile must be an absolute local path");
      }
    }
  }
  return location;
}

export class ProjectService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at")
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw httpError(404, "project not found");
    return toProject(row);
  }

  create(input: CreateProjectInput): Project {
    const location = normalizeLocation(input);
    const rootPath = location.kind === "ssh"
      ? normalizeWindowsPath(input.rootPath)
      : path.resolve(input.rootPath);
    if (location.kind === "local" && (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory())) {
      throw httpError(400, `rootPath is not a directory: ${rootPath}`);
    }
    const project: Project = {
      id: newId("p"),
      name: input.name,
      rootPath,
      location,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, location, ssh_host, ssh_port, ssh_username, ssh_auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.location.kind,
        project.location.kind === "ssh" ? project.location.host : null,
        project.location.kind === "ssh" ? project.location.port : null,
        project.location.kind === "ssh" ? project.location.username : null,
        project.location.kind === "ssh" ? JSON.stringify(project.location.auth) : null,
        project.createdAt,
      );
    return project;
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const current = this.get(id);
    const name = patch.name ?? current.name;
    const nextLocation = patch.location ?? current.location;
    const location = normalizeLocation({ location: nextLocation });
    if (location.kind !== current.location.kind ||
        (location.kind === "ssh" &&
          current.location.kind === "ssh" &&
          (location.host !== current.location.host ||
            location.port !== current.location.port ||
            location.username !== current.location.username ||
            JSON.stringify(location.auth) !== JSON.stringify(current.location.auth)))) {
      const count = this.db
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?")
        .get(id) as { count: number };
      if (count.count > 0) {
        throw httpError(409, "project location cannot change while sessions exist");
      }
    }
    let rootPath = current.rootPath;
    if (patch.rootPath !== undefined) {
      rootPath = location.kind === "ssh"
        ? normalizeWindowsPath(patch.rootPath)
        : path.resolve(patch.rootPath);
    } else if (location.kind !== current.location.kind) {
      rootPath = location.kind === "ssh"
        ? normalizeWindowsPath(rootPath)
        : path.resolve(rootPath);
    }
    if (
      location.kind === "local" &&
      (patch.rootPath !== undefined || current.location.kind !== "local") &&
      (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory())
    ) {
      throw httpError(400, `rootPath is not a directory: ${rootPath}`);
    }
    this.db
      .prepare(
        "UPDATE projects SET name = ?, root_path = ?, location = ?, ssh_host = ?, ssh_port = ?, ssh_username = ?, ssh_auth = ? WHERE id = ?",
      )
      .run(
        name,
        rootPath,
        location.kind,
        location.kind === "ssh" ? location.host : null,
        location.kind === "ssh" ? location.port : null,
        location.kind === "ssh" ? location.username : null,
        location.kind === "ssh" ? JSON.stringify(location.auth) : null,
        id,
      );
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?")
      .get(id) as { count: number };
    if (count.count > 0) {
      throw httpError(409, "project still has sessions; delete them first");
    }
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}
