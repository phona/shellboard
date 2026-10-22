import { execa } from "execa";
import fs from "node:fs";
import { expect, it } from "vitest";
import { HttpError } from "../src/errors";
import { defaultShell } from "../src/env";
import type { Services } from "../src/services";
import { afterAllCleanup, createServices, makeTempDir } from "./helpers";

afterAllCleanup();

/** The pane process's own environment (Linux /proc). `tmux show-environment`
    only proves the session environment was set; this proves the launched
    process actually inherited it. */
function paneEnviron(pid: number): string[] {
  return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
}

async function panePid(services: Services, tmuxName: string): Promise<number> {
  const result = await execa(
    "tmux",
    ["-L", services.config.tmuxSocket, "list-panes", "-t", tmuxName, "-F", "#{pane_pid}"],
    { reject: false },
  );
  const pid = Number(result.stdout.trim());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`no pane pid for ${tmuxName}`);
  return pid;
}

let counter = 0;

async function createShellSession(services: Services, prefix: string) {
  counter += 1;
  const dir = makeTempDir();
  const project = services.projects.create({
    name: `${prefix}-proj-${counter}`,
    rootPath: dir,
  });
  const created = await services.sessions.create({
    projectId: project.id,
    name: `${prefix}-${counter}`,
    agentType: "shell",
  });
  return { dir, project, created };
}

it("creates a real tmux session and kills both DB row and session", async () => {
  const services = await createServices();
  const { created } = await createShellSession(services, "svc");
  expect(await services.tmux.sessionExists(created.session.tmuxName)).toBe(true);

  await services.sessions.kill(created.session.id);
  expect(await services.tmux.sessionExists(created.session.tmuxName)).toBe(false);
  expect(() => services.sessions.get(created.session.id)).toThrow();
});

it("restarts with the same tmux name and command", async () => {
  const services = await createServices();
  const { created } = await createShellSession(services, "rst");
  const tmuxName = created.session.tmuxName;

  await services.sessions.restart(created.session.id);
  expect(await services.tmux.sessionExists(tmuxName)).toBe(true);
  expect(services.sessions.get(created.session.id).tmuxName).toBe(tmuxName);
});

it("reports exited when tmux dies externally — observation, not DB trust", async () => {  const services = await createServices();
  const { created } = await createShellSession(services, "ext");

  await execa(
    "tmux",
    ["-L", services.config.tmuxSocket, "kill-session", "-t", created.session.tmuxName],
    { reject: false },
  );
  await services.observer.tick();

  const runtime = services.tracker.get(created.session.id);
  expect(runtime.alive).toBe(false);
  expect(runtime.activity).toBe("exited");
});

it("rejects a custom command whose binary is missing", async () => {
  const services = await createServices();
  const dir = makeTempDir();
  const project = services.projects.create({ name: "binproj", rootPath: dir });
  await expect(
    services.sessions.create({
      projectId: project.id,
      name: "nope",
      agentType: "custom",
      command: "definitely-not-a-real-binary-xyz",
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("passes the launch env to the pane process, spaces included (D9)", async () => {
  const services = await createServices();
  const dir = makeTempDir();
  const project = services.projects.create({ name: "envproj", rootPath: dir });
  const created = await services.sessions.create({
    projectId: project.id,
    name: "env-session",
    agentType: "custom",
    command: "sleep 60",
    env: { SB_MODEL: "sonnet", SB_NOTE: "hello world" },
  });

  const env = paneEnviron(await panePid(services, created.session.tmuxName));
  expect(env).toContain("SB_MODEL=sonnet");
  expect(env).toContain("SB_NOTE=hello world");
  // tmux's own variables must survive untouched
  expect(env.some((entry) => entry.startsWith("TMUX="))).toBe(true);
  expect(env).toContain("TERM=tmux-256color");

  await services.sessions.kill(created.session.id);
});

it("re-applies the stored env on restart", async () => {
  const services = await createServices();
  const dir = makeTempDir();
  const project = services.projects.create({ name: "restartenv", rootPath: dir });
  const created = await services.sessions.create({
    projectId: project.id,
    name: "restart-env",
    agentType: "custom",
    command: "sleep 60",
    env: { SB_MODEL: "opus" },
  });

  const restarted = await services.sessions.restart(created.session.id);
  expect(restarted.session.env).toEqual({ SB_MODEL: "opus" });
  const env = paneEnviron(await panePid(services, created.session.tmuxName));
  expect(env).toContain("SB_MODEL=opus");

  await services.sessions.kill(created.session.id);
});

it("applies env to a built-in agent type, not only custom", async () => {
  const services = await createServices();
  const dir = makeTempDir();
  const project = services.projects.create({ name: "shellenv", rootPath: dir });
  // A shell session is the always-installed built-in type: env is not a
  // custom-command-only feature.
  const created = await services.sessions.create({
    projectId: project.id,
    name: "shell-env",
    agentType: "shell",
    env: { SB_SHELL: "yes" },
  });
  expect(created.session.command).toEqual([defaultShell()]);

  const env = paneEnviron(await panePid(services, created.session.tmuxName));
  expect(env).toContain("SB_SHELL=yes");

  await services.sessions.kill(created.session.id);
});

it("refuses project deletion while sessions exist", async () => {
  const services = await createServices();
  const { project, created } = await createShellSession(services, "del");
  expect(() => services.projects.remove(project.id)).toThrow(HttpError);
  await services.sessions.kill(created.session.id);
  expect(() => services.projects.remove(project.id)).not.toThrow();
});
