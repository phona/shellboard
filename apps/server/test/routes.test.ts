import { expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { buildServices } from "../src/services";
import { afterAllCleanup, createServices, makeTempDir } from "./helpers";

afterAllCleanup();

it("serves the full REST flow over real services", async () => {
  const services = await createServices();
  const app = await buildApp(services, { logger: false });
  const dir = makeTempDir();

  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "flow", rootPath: dir },
  });
  expect(projectRes.statusCode).toBe(201);
  const project = projectRes.json();

  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.id, name: "s1", agentType: "shell" },
  });
  expect(sessionRes.statusCode).toBe(201);
  const sessionId = sessionRes.json().session.id as string;
  expect(await services.tmux.sessionExists(sessionRes.json().session.tmuxName)).toBe(true);

  const listRes = await app.inject({ method: "GET", url: "/api/sessions" });
  expect(listRes.statusCode).toBe(200);
  const listed = listRes.json().sessions as Array<{ session: { id: string }; runtime: { activity: string } }>;
  expect(listed.some((item) => item.session.id === sessionId)).toBe(true);
  expect(listed.find((item) => item.session.id === sessionId)?.runtime.activity).toBeDefined();

  // project with sessions is protected
  const deleteProjectRes = await app.inject({
    method: "DELETE",
    url: `/api/projects/${project.id}`,
  });
  expect(deleteProjectRes.statusCode).toBe(409);

  // git endpoints respond even outside a repo
  const statusRes = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/git/status`,
  });
  expect(statusRes.statusCode).toBe(200);
  expect(statusRes.json()).toEqual({ branch: null, entries: [] });

  // files flow
  const saveRes = await app.inject({
    method: "PUT",
    url: `/api/sessions/${sessionId}/files/content?path=note.txt`,
    payload: { content: "hello route", encoding: "utf8" },
  });
  expect(saveRes.statusCode).toBe(200);
  const contentRes = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/files/content?path=note.txt`,
  });
  expect(contentRes.json().content).toBe("hello route");

  const traversalRes = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/files/content?path=${encodeURIComponent("../../etc/passwd")}`,
  });
  expect(traversalRes.statusCode).toBe(400);

  const restartRes = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/restart`,
  });
  expect(restartRes.statusCode).toBe(200);

  const killRes = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
  expect(killRes.statusCode).toBe(200);

  const deleteProjectAfter = await app.inject({
    method: "DELETE",
    url: `/api/projects/${project.id}`,
  });
  expect(deleteProjectAfter.statusCode).toBe(200);

  await app.close();
});

it("requires the token when SHELLBOARD_TOKEN is set", async () => {
  const config = { ...loadConfig(), token: "secret-token" };
  const services = buildServices(config);
  const app = await buildApp(services, { logger: false });

  const anonymous = await app.inject({ method: "GET", url: "/api/projects" });
  expect(anonymous.statusCode).toBe(401);

  const wrongLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { token: "wrong" },
  });
  expect(wrongLogin.statusCode).toBe(401);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { token: "secret-token" },
  });
  expect(login.statusCode).toBe(200);
  expect(login.headers["set-cookie"]).toBeDefined();

  const authorized = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { cookie: "sb_token=secret-token" },
  });
  expect(authorized.statusCode).toBe(200);

  await services.tmux.killServer();
  services.db.close();
  await app.close();
});
