import { expect, it } from "vitest";
import { afterAllCleanup, createServices, makeTempDir } from "./helpers";

afterAllCleanup();

it("creates, updates, and removes a registered command", async () => {
  const services = await createServices();
  const created = services.commands.create({
    name: "claude-sonnet",
    command: "claude --model sonnet",
    env: { ANTHROPIC_MODEL: "sonnet" },
  });
  expect(created.id).toMatch(/^c_/);
  expect(created.env).toEqual({ ANTHROPIC_MODEL: "sonnet" });

  expect(services.commands.list()).toHaveLength(1);
  expect(services.commands.get(created.id).command).toBe("claude --model sonnet");

  const renamed = services.commands.update(created.id, { name: "claude-opus" });
  expect(renamed.name).toBe("claude-opus");

  // A patch that omits env keeps it; an explicit env replaces it wholesale.
  const kept = services.commands.update(created.id, { command: "claude" });
  expect(kept.env).toEqual({ ANTHROPIC_MODEL: "sonnet" });
  const cleared = services.commands.update(created.id, { env: {} });
  expect(cleared.env).toEqual({});

  services.commands.remove(created.id);
  expect(services.commands.list()).toEqual([]);
  expect(() => services.commands.get(created.id)).toThrow();
});

it("rejects a duplicate name with 409 and an unknown id with 404", async () => {
  const services = await createServices();
  services.commands.create({ name: "dup", command: "echo hi" });
  expect(() => services.commands.create({ name: "dup", command: "echo other" })).toThrow(
    expect.objectContaining({ statusCode: 409 }),
  );
  // The rename path hits the same UNIQUE constraint
  const first = services.commands.create({ name: "first", command: "echo a" });
  expect(() => services.commands.update(first.id, { name: "dup" })).toThrow(
    expect.objectContaining({ statusCode: 409 }),
  );
  expect(() => services.commands.update("c_missing", { name: "x" })).toThrow(
    expect.objectContaining({ statusCode: 404 }),
  );
  expect(() => services.commands.remove("c_missing")).toThrow(
    expect.objectContaining({ statusCode: 404 }),
  );
});

it("reads a legacy row's env as an empty map", async () => {
  const services = await createServices();
  services.db
    .prepare("INSERT INTO commands (id, name, command, env, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("c_legacy", "legacy", "echo hi", "not json", new Date().toISOString());
  expect(services.commands.get("c_legacy").env).toEqual({});
});

it("deleting a preset leaves the session it launched untouched", async () => {
  const services = await createServices();
  const dir = makeTempDir();
  const project = services.projects.create({ name: "cmdproj", rootPath: dir });
  const preset = services.commands.create({
    name: "waiter",
    command: "sleep 60",
    env: { SB_PRESET: "yes" },
  });
  const created = await services.sessions.create({
    projectId: project.id,
    name: "from-preset",
    agentType: "custom",
    command: preset.command,
    env: preset.env,
  });
  expect(created.session.env).toEqual({ SB_PRESET: "yes" });

  services.commands.remove(preset.id);
  expect(services.sessions.get(created.session.id).command).toEqual(["sleep", "60"]);
  expect(services.sessions.get(created.session.id).env).toEqual({ SB_PRESET: "yes" });
  await services.sessions.kill(created.session.id);
});

it("defaults a created command's env when the input omits it", async () => {
  const services = await createServices();
  const created = services.commands.create({ name: "plain", command: "echo hi" });
  expect(created.env).toEqual({});
  expect(JSON.parse(
    (services.db.prepare("SELECT env FROM commands WHERE id = ?").get(created.id) as { env: string })
      .env,
  )).toEqual({});
});
