import { execa } from "execa";
import type { GitEntry, GitStatus } from "@shellboard/contracts";

export interface GitDiffOptions {
  staged?: boolean;
  path?: string | null;
}

export class GitService {
  async status(cwd: string): Promise<GitStatus> {
    const result = await execa(
      "git",
      ["-C", cwd, "status", "--porcelain=v2", "--branch"],
      { reject: false },
    );
    if (result.failed) return { branch: null, entries: [] };
    return parseStatus(result.stdout);
  }

  async diff(cwd: string, options: GitDiffOptions): Promise<string> {
    const args = ["-C", cwd, "diff", "--no-ext-diff"];
    if (options.staged) args.push("--cached");
    if (options.path) args.push("--", options.path);
    const result = await execa("git", args, { reject: false });
    return result.stdout;
  }

  async stage(cwd: string, entryPath: string): Promise<void> {
    await execa("git", ["-C", cwd, "add", "--", entryPath]);
  }

  async unstage(cwd: string, entryPath: string): Promise<void> {
    await execa("git", ["-C", cwd, "restore", "--staged", "--", entryPath]);
  }

  async discard(cwd: string, entry: GitEntry): Promise<void> {
    const untracked = entry.x === "?" || entry.y === "?";
    if (untracked) {
      await execa("git", ["-C", cwd, "clean", "-f", "--", entry.path]);
    } else {
      await execa("git", ["-C", cwd, "restore", "--worktree", "--", entry.path]);
    }
  }
}

function parseStatus(output: string): GitStatus {
  let branch: string | null = null;
  const entries: GitEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
      continue;
    }
    if (line.startsWith("1 ")) {
      const tokens = line.split(" ");
      const xy = tokens[1] ?? "  ";
      const x = xy[0] ?? " ";
      const y = xy[1] ?? " ";
      const entryPath = tokens.slice(8).join(" ");
      if (entryPath) entries.push({ path: entryPath, origPath: null, x, y });
      continue;
    }
    if (line.startsWith("2 ")) {
      const tokens = line.split(" ");
      const xy = tokens[1] ?? "  ";
      const x = xy[0] ?? " ";
      const y = xy[1] ?? " ";
      const rest = tokens.slice(9).join(" ");
      const [current, orig] = rest.split("\t");
      entries.push({ path: current ?? "", origPath: orig ?? null, x, y });
      continue;
    }
    if (line.startsWith("u ")) {
      const tokens = line.split(" ");
      const entryPath = tokens[tokens.length - 1] ?? "";
      if (entryPath) entries.push({ path: entryPath, origPath: null, x: "U", y: "U" });
      continue;
    }
    if (line.startsWith("? ")) {
      const entryPath = line.slice(2);
      if (entryPath) entries.push({ path: entryPath, origPath: null, x: "?", y: "?" });
    }
  }
  return { branch, entries };
}
