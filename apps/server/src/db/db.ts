import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "migrations");

export function openDatabase(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const rows = db.prepare("SELECT version FROM _migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(rows.map((row) => row.version));
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file.split("-")[0] ?? "", 10);
    if (!Number.isFinite(version) || applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(version, file, new Date().toISOString());
    });
    apply();
  }
}
