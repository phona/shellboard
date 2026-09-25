import fs from "node:fs";
import path from "node:path";
import type { CreateProjectInput, Project, UpdateProjectInput } from "@shellboard/contracts";
import type { Db } from "../db/db.js";
import { httpError } from "../errors.js";
import { newId } from "../ids.js";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
  };
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
    const rootPath = path.resolve(input.rootPath);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw httpError(400, `rootPath is not a directory: ${rootPath}`);
    }
    const project: Project = {
      id: newId("p"),
      name: input.name,
      rootPath,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.rootPath, project.createdAt);
    return project;
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const current = this.get(id);
    const name = patch.name ?? current.name;
    let rootPath = current.rootPath;
    if (patch.rootPath !== undefined) {
      rootPath = path.resolve(patch.rootPath);
      if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
        throw httpError(400, `rootPath is not a directory: ${rootPath}`);
      }
    }
    this.db.prepare("UPDATE projects SET name = ?, root_path = ? WHERE id = ?").run(
      name,
      rootPath,
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
