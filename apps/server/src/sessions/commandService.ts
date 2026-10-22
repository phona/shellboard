import type {
  Command,
  CreateCommandInput,
  EnvVarMap,
  UpdateCommandInput,
} from "@shellboard/contracts";
import type { Db } from "../db/db.js";
import { httpError } from "../errors.js";
import { newId } from "../ids.js";

interface CommandRow {
  id: string;
  name: string;
  command: string;
  env: string;
  created_at: string;
}

/**
 * Registered launch commands (D9): server-side presets the new-session dialog
 * offers as one-click entries. A session snapshots `command` + `env` when it is
 * created, so editing or deleting a preset here never touches a running
 * session.
 *
 * Env values are user secrets in practice (API keys, model pins) and are never
 * logged: the service logs nothing, and no route logs a request body.
 */
export class CommandService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): Command[] {
    const rows = this.db
      .prepare("SELECT * FROM commands ORDER BY created_at")
      .all() as CommandRow[];
    return rows.map(toCommand);
  }

  get(id: string): Command {
    const row = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as
      | CommandRow
      | undefined;
    if (!row) throw httpError(404, "command not found");
    return toCommand(row);
  }

  create(input: CreateCommandInput): Command {
    const command: Command = {
      id: newId("c"),
      name: input.name,
      command: input.command,
      env: input.env ?? {},
      createdAt: new Date().toISOString(),
    };
    this.guardUnique(command.name, () =>
      this.db
        .prepare(
          "INSERT INTO commands (id, name, command, env, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          command.id,
          command.name,
          command.command,
          JSON.stringify(command.env),
          command.createdAt,
        ),
    );
    return command;
  }

  update(id: string, patch: UpdateCommandInput): Command {
    const current = this.get(id);
    const next: Command = {
      id: current.id,
      name: patch.name ?? current.name,
      command: patch.command ?? current.command,
      env: patch.env ?? current.env,
      createdAt: current.createdAt,
    };
    this.guardUnique(next.name, () =>
      this.db
        .prepare("UPDATE commands SET name = ?, command = ?, env = ? WHERE id = ?")
        .run(next.name, next.command, JSON.stringify(next.env), next.id),
    );
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.prepare("DELETE FROM commands WHERE id = ?").run(id);
  }

  /** Surfaces the UNIQUE constraint on `name` as a readable 409 instead of a
      raw SQLite error. */
  private guardUnique(name: string, write: () => void): void {
    try {
      write();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw httpError(409, `a command named "${name}" already exists`);
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE";
}

function toCommand(row: CommandRow): Command {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    env: parseEnv(row.env),
    createdAt: row.created_at,
  };
}

/** Rows written before the env column existed (and any hand-edited row) read
    back as an empty map rather than failing the whole list. */
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
