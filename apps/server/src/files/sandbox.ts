import fs from "node:fs";
import path from "node:path";
import { httpError } from "../errors.js";

/**
 * Path sandbox (D1): everything is resolved against the session cwd, then
 * re-verified through realpath so symlinks cannot escape the boundary.
 */
export function sessionRoot(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    throw httpError(400, `session cwd does not exist: ${cwd}`);
  }
}

export function resolveInside(rootReal: string, requested: string): string {
  if (requested.includes("\0")) throw httpError(400, "invalid path");
  const resolved = path.resolve(rootReal, requested);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw httpError(400, "path escapes the session directory");
  }
  return resolved;
}

/**
 * Resolves `requested` inside `rootReal`, following symlinks for the
 * deepest existing ancestor and re-checking containment afterwards.
 * Returns a concrete path (real prefix + lexical remainder).
 */
export function realpathInside(rootReal: string, requested: string): string {
  const resolved = resolveInside(rootReal, requested);
  const missing: string[] = [];
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    missing.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw httpError(400, "cannot resolve path");
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw httpError(400, "symlink escapes the session directory");
  }
  return path.join(real, ...missing);
}

export function toRelativePosix(rootReal: string, absolute: string): string {
  return path.relative(rootReal, absolute).split(path.sep).join("/");
}
