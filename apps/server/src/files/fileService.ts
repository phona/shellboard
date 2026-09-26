import fs from "node:fs";
import path from "node:path";
import type {
  CreateFileInput,
  FileContent,
  FileEntry,
  FileList,
  SaveFileInput,
} from "@shellboard/contracts";
import { httpError } from "../errors.js";
import {
  realpathInside,
  resolveInside,
  sessionRoot,
  toRelativePosix,
} from "./sandbox.js";

const MAX_OPEN_BYTES = 2 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

function isBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function typeOf(dirent: fs.Dirent): FileEntry["type"] {
  if (dirent.isDirectory()) return "dir";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

export class FileService {
  list(cwd: string, relPath: string): FileList {
    const root = sessionRoot(cwd);
    const dir = realpathInside(root, relPath || ".");
    if (!fs.statSync(dir).isDirectory()) {
      throw httpError(400, `not a directory: ${relPath}`);
    }
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const absolute = path.join(dir, dirent.name);
      let size = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(absolute);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        // broken symlink or vanished entry: report with zeroed metadata
      }
      entries.push({
        name: dirent.name,
        path: toRelativePosix(root, absolute),
        type: typeOf(dirent),
        size,
        mtime,
      });
    }
    entries.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    return { path: toRelativePosix(root, dir) || ".", entries };
  }

  content(cwd: string, relPath: string): FileContent {
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, relPath);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) throw httpError(400, `not a file: ${relPath}`);
    if (stat.size > MAX_OPEN_BYTES) {
      throw httpError(413, "file too large to open (>2MB)");
    }
    const buf = fs.readFileSync(absolute);
    const binary = isBinary(buf);
    return {
      path: toRelativePosix(root, absolute),
      content: binary ? buf.toString("base64") : buf.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      binary,
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  readRaw(cwd: string, relPath: string): Buffer {
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, relPath);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) throw httpError(400, `not a file: ${relPath}`);
    if (stat.size > MAX_TRANSFER_BYTES) {
      throw httpError(413, "file too large to download (>100MB)");
    }
    return fs.readFileSync(absolute);
  }

  save(cwd: string, relPath: string, input: SaveFileInput): { mtime: number } {
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, relPath);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      throw httpError(400, `not a file: ${relPath}`);
    }
    if (input.mtime !== undefined && fs.existsSync(absolute)) {
      const current = fs.statSync(absolute).mtimeMs;
      if (Math.abs(current - input.mtime) > 1) {
        throw httpError(409, "file changed on disk since it was opened");
      }
    }
    const data =
      input.encoding === "base64"
        ? Buffer.from(input.content, "base64")
        : Buffer.from(input.content, "utf8");
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const tmp = `${absolute}.sb-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, absolute);
    return { mtime: fs.statSync(absolute).mtimeMs };
  }

  create(cwd: string, input: CreateFileInput): FileEntry {
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, input.path);
    if (fs.existsSync(absolute)) throw httpError(409, `already exists: ${input.path}`);
    if (input.type === "dir") {
      fs.mkdirSync(absolute, { recursive: true });
    } else {
      const data =
        input.encoding === "base64" && input.content !== undefined
          ? Buffer.from(input.content, "base64")
          : Buffer.from(input.content ?? "", "utf8");
      fs.writeFileSync(absolute, data);
    }
    const stat = fs.statSync(absolute);
    return {
      name: path.basename(absolute),
      path: toRelativePosix(root, absolute),
      type: input.type === "dir" ? "dir" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  /**
   * Binary upload into a directory inside the session cwd (explicit intent:
   * the user navigated there). Conflicts are 409 — the working tree is the
   * user's repo, never silently overwritten. The buffer lane (UploadService)
   * uniquifies instead; the two lanes have different contracts on purpose.
   */
  upload(cwd: string, relDir: string, fileName: string, data: Buffer): FileEntry {
    if (
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes("\0") ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw httpError(400, "invalid name");
    }
    const root = sessionRoot(cwd);
    const dir = realpathInside(root, relDir || ".");
    if (!fs.statSync(dir).isDirectory()) {
      throw httpError(400, `not a directory: ${relDir}`);
    }
    const absolute = resolveInside(dir, fileName);
    if (fs.existsSync(absolute)) throw httpError(409, `already exists: ${fileName}`);
    const tmp = `${absolute}.sb-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, absolute);
    const stat = fs.statSync(absolute);
    return {
      name: fileName,
      path: toRelativePosix(root, absolute),
      type: "file",
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  rename(cwd: string, relPath: string, newName: string): void {
    if (newName.includes("/") || newName.includes("\\") || newName.includes("\0")) {
      throw httpError(400, "invalid name");
    }
    if (newName === "." || newName === "..") throw httpError(400, "invalid name");
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, relPath);
    if (absolute === root) throw httpError(400, "cannot rename the session directory");
    const target = resolveInside(root, path.join(path.dirname(absolute), newName));
    if (fs.existsSync(target)) throw httpError(409, `already exists: ${newName}`);
    fs.renameSync(absolute, target);
  }

  remove(cwd: string, relPath: string, recursive: boolean): void {
    const root = sessionRoot(cwd);
    const absolute = realpathInside(root, relPath);
    if (absolute === root) throw httpError(400, "refusing to delete the session directory");
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      if (!recursive && fs.readdirSync(absolute).length > 0) {
        throw httpError(400, "directory not empty (delete recursively instead)");
      }
      fs.rmSync(absolute, { recursive: true });
    } else {
      fs.rmSync(absolute);
    }
  }
}
