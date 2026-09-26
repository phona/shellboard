import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { DirectoryEntry, DirectoryListing } from "@shellboard/contracts";
import { httpError } from "../errors.js";
import { queryString } from "../http/helpers.js";

/**
 * Read-only directory browsing for the project-location picker. Lists
 * directory names only — no file contents, no writes — and is protected by
 * the same auth hook as every other /api route.
 */
export function registerFsRoutes(app: FastifyInstance): void {
  app.get("/api/fs/directories", async (request) => {
    const query = queryString(request);
    const requested = query["path"]?.trim() || os.homedir();
    if (!path.isAbsolute(requested)) {
      throw httpError(400, "path must be absolute");
    }
    const dir = path.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw httpError(400, `directory not found: ${dir}`);
    }
    if (!stat.isDirectory()) {
      throw httpError(400, `not a directory: ${dir}`);
    }
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // unreadable (permissions): return an empty listing; Up still works
    }
    const entries: DirectoryEntry[] = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => ({ name: dirent.name, path: path.join(dir, dirent.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    const listing: DirectoryListing = {
      path: dir,
      parent: parent === dir ? null : parent,
      entries,
    };
    return listing;
  });
}
