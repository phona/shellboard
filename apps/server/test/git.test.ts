import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { GitService } from "../src/git/gitService";

const git = new GitService();

async function seedRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join("/tmp", "sb-git-"));
  await execa("git", ["init", "-b", "main", dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  await execa("git", ["-C", dir, "add", "a.txt"]);
  await execa("git", ["-C", dir, "commit", "-m", "init"]);
  return dir;
}

it("parses branch and entries from porcelain v2", async () => {
  const repo = await seedRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "new file\n");

  const status = await git.status(repo);
  expect(status.branch).toBe("main");
  const modified = status.entries.find((entry) => entry.path === "a.txt");
  expect(modified?.y).toBe("M");
  const untracked = status.entries.find((entry) => entry.path === "b.txt");
  expect(untracked?.x).toBe("?");

  await execa("git", ["-C", repo, "clean", "-fd"]);
});

it("returns empty status outside a repository", async () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "sb-nogit-"));
  const status = await git.status(dir);
  expect(status.branch).toBeNull();
  expect(status.entries).toEqual([]);
});

it("produces diff text matching the CLI", async () => {
  const repo = await seedRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  const text = await git.diff(repo, {});
  expect(text).toContain("diff --git");
  expect(text).toContain("+changed");
});

it("stage → unstage → discard round trip", async () => {
  const repo = await seedRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

  await git.stage(repo, "a.txt");
  let status = await git.status(repo);
  expect(status.entries.find((entry) => entry.path === "a.txt")?.x).toBe("M");
  const staged = await git.diff(repo, { staged: true, path: "a.txt" });
  expect(staged).toContain("+changed");

  await git.unstage(repo, "a.txt");
  status = await git.status(repo);
  expect(status.entries.find((entry) => entry.path === "a.txt")?.y).toBe("M");

  const entry = status.entries.find((candidate) => candidate.path === "a.txt");
  await git.discard(repo, entry!);
  expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("hello\n");
});

it("discards untracked files", async () => {
  const repo = await seedRepo();
  const stray = path.join(repo, "stray.txt");
  fs.writeFileSync(stray, "stray\n");
  const status = await git.status(repo);
  const entry = status.entries.find((candidate) => candidate.path === "stray.txt");
  await git.discard(repo, entry!);
  expect(fs.existsSync(stray)).toBe(false);
});
