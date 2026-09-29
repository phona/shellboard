import fs from "node:fs";
import path from "node:path";
import type { UploadEntry, UploadList } from "@shellboard/contracts";
import { httpError } from "../errors.js";

const SESSION_ID = /^s_[A-Za-z0-9_-]+$/;

/**
 * The upload buffer (attachments lane): ~/.shellboard/uploads/<sessionId>/.
 * This is the one explicitly modeled root outside the session cwd (D1
 * amendment) — files land here so they are reachable by the agent through an
 * absolute path without ever writing into the working tree. Names are
 * sanitized to bare basenames and symlinked entries are refused, so nothing
 * inside the buffer can point outside the root.
 */
export class UploadService {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  upload(sessionId: string, requestedName: string, data: Buffer): UploadEntry {
    const name = sanitizeName(requestedName);
    const dir = this.sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.uniqueTarget(dir, name);
    const tmp = `${target}.sb-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return this.toEntry(target);
  }

  list(sessionId: string): UploadList {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) return { entries: [] };
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => dirent.isFile())
      .map((dirent) => this.toEntry(path.join(dir, dirent.name)))
      .sort((a, b) => b.mtime - a.mtime);
    return { entries };
  }

  remove(sessionId: string, requestedName: string): void {
    const name = sanitizeName(requestedName);
    const target = this.existingTarget(sessionId, name);
    fs.rmSync(target);
  }

  /** Absolute path of a buffer entry — the text "Send to terminal" types. */
  absolutePath(sessionId: string, requestedName: string): string {
    return this.existingTarget(sessionId, sanitizeName(requestedName));
  }

  /** Called when a session is deleted: its buffer has no owner left. */
  dropSession(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw httpError(400, "invalid session id");
    fs.rmSync(path.join(this.root, sessionId), { recursive: true, force: true });
  }

  private sessionDir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw httpError(400, "invalid session id");
    return path.join(this.root, sessionId);
  }

  /**
   * A name never collides: taken names (including broken symlinks — lstat,
   * not exists) get a -2/-3… infix before the extension. The returned target
   * never pre-exists, so the tmp+rename write cannot follow a symlink.
   */
  private uniqueTarget(dir: string, name: string): string {
    const ext = path.extname(name);
    const stem = ext.length > 0 ? name.slice(0, name.length - ext.length) : name;
    let target = path.join(dir, name);
    for (let i = 2; fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined; i++) {
      target = path.join(dir, `${stem}-${i}${ext}`);
    }
    return target;
  }

  private existingTarget(sessionId: string, name: string): string {
    const dir = this.sessionDir(sessionId);
    const target = path.join(dir, name);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) === undefined) {
      throw httpError(404, `no such upload: ${name}`);
    }
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw httpError(400, "refusing to follow symlinks in the uploads directory");
    }
    return target;
  }

  private toEntry(absolute: string): UploadEntry {
    const stat = fs.statSync(absolute);
    return {
      name: path.basename(absolute),
      path: absolute,
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }
}

function sanitizeName(name: string): string {
  // Control characters are rejected before anything else: a newline in a
  // buffer name would turn "Send to terminal" (D6) into a line submit.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw httpError(400, "invalid file name");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw httpError(400, "invalid file name");
  }
  const base = path.basename(name);
  if (base.length === 0 || base === "." || base === "..") {
    throw httpError(400, "invalid file name");
  }
  return base;
}
