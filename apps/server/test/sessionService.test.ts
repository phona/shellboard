import { execa } from "execa";
import { expect, it } from "vitest";
import { HttpError } from "../src/errors";
import type { Services } from "../src/services";
import { afterAllCleanup, createServices, makeTempDir } from "./helpers";

afterAllCleanup();

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

it("reports exited when tmux dies externally — observation, not DB trust", async () => {
  const services = await createServices();
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

it("refuses project deletion while sessions exist", async () => {
  const services = await createServices();
  const { project, created } = await createShellSession(services, "del");
  expect(() => services.projects.remove(project.id)).toThrow(HttpError);
  await services.sessions.kill(created.session.id);
  expect(() => services.projects.remove(project.id)).not.toThrow();
});
