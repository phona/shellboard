import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { Services } from "../src/services";
import { afterAllCleanup, createServices, makeTempDir, sleep } from "./helpers";

afterAllCleanup();

let counter = 0;

async function createShellSession(services: Services) {
  counter += 1;
  const dir = makeTempDir();
  const project = services.projects.create({
    name: `up-proj-${counter}`,
    rootPath: dir,
  });
  const created = await services.sessions.create({
    projectId: project.id,
    name: `up-${counter}`,
    agentType: "shell",
  });
  return { sessionId: created.session.id, tmuxName: created.session.tmuxName, cwd: dir };
}

function bufferDir(services: Services, sessionId: string): string {
  return path.join(services.config.homeDir, "uploads", sessionId);
}

function postUpload(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  name: string,
  raw: Buffer,
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/uploads?name=${encodeURIComponent(name)}`,
    payload: raw,
    headers: { "content-type": "application/octet-stream" },
  });
}

it("buffer upload lands in ~/.shellboard/uploads/<sid> with bytes intact", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x42]);
  const res = await postUpload(app, sessionId, "shot.png", raw);
  expect(res.statusCode).toBe(201);
  const entry = res.json() as { name: string; path: string; size: number };
  expect(entry.name).toBe("shot.png");
  expect(entry.path).toBe(path.join(bufferDir(services, sessionId), "shot.png"));
  expect(fs.readFileSync(entry.path).equals(raw)).toBe(true);
  expect(entry.size).toBe(raw.length);

  await app.close();
});

it("buffer collisions uniquify instead of overwriting or erroring", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  const first = await postUpload(app, sessionId, "notes.pdf", Buffer.from("one"));
  const second = await postUpload(app, sessionId, "notes.pdf", Buffer.from("two"));
  expect(first.json().name).toBe("notes.pdf");
  expect(second.json().name).toBe("notes-2.pdf");
  expect(fs.readFileSync(first.json().path, "utf8")).toBe("one");
  expect(fs.readFileSync(second.json().path, "utf8")).toBe("two");

  await app.close();
});

it("lists the buffer newest-first and deletes by name", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  await postUpload(app, sessionId, "a.txt", Buffer.from("a"));
  await postUpload(app, sessionId, "b.txt", Buffer.from("b"));

  const list = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/uploads` });
  expect(list.statusCode).toBe(200);
  const names = (list.json().entries as Array<{ name: string }>).map((entry) => entry.name);
  expect(names).toContain("a.txt");
  expect(names).toContain("b.txt");
  const times = (list.json().entries as Array<{ mtime: number }>).map((entry) => entry.mtime);
  expect([...times].sort((a, b) => b - a)).toEqual(times);

  const del = await app.inject({
    method: "DELETE",
    url: `/api/sessions/${sessionId}/uploads?name=a.txt`,
  });
  expect(del.statusCode).toBe(200);
  expect(fs.existsSync(path.join(bufferDir(services, sessionId), "a.txt"))).toBe(false);

  const missing = await app.inject({
    method: "DELETE",
    url: `/api/sessions/${sessionId}/uploads?name=a.txt`,
  });
  expect(missing.statusCode).toBe(404);

  await app.close();
});

it("rejects file-name traversal and non-binary bodies", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  for (const name of ["../evil", "sub/evil.txt", "back\\slash", "bad\0name", ".", ".."]) {
    const res = await postUpload(app, sessionId, name, Buffer.from("x"));
    expect(res.statusCode, name).toBe(400);
  }
  // every name was rejected before anything was written (the dir may not
  // even exist — mkdir only happens for an accepted upload)
  expect(fs.existsSync(bufferDir(services, sessionId))).toBe(false);

  const jsonBody = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/uploads?name=x.bin`,
    payload: { not: "a buffer" },
  });
  expect(jsonBody.statusCode).toBe(400);

  const noName = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/uploads`,
    payload: Buffer.from("x"),
    headers: { "content-type": "application/octet-stream" },
  });
  expect(noName.statusCode).toBe(400);

  await app.close();
});

it("refuses symlinked entries inside the buffer (no escape via write or send)", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  const dir = bufferDir(services, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync("/etc", path.join(dir, "evil"));

  // "evil" is taken (lstat sees the link) → uniquified, never followed
  const res = await postUpload(app, sessionId, "evil", Buffer.from("x"));
  expect(res.statusCode).toBe(201);
  expect(res.json().name).toBe("evil-2");

  let status = 0;
  try {
    services.uploads.absolutePath(sessionId, "evil");
  } catch (err) {
    status = (err as { statusCode?: number }).statusCode ?? 0;
  }
  expect(status).toBe(400);

  await app.close();
});

it("binary upload into a cwd directory keeps the repo lane contract", async () => {
  const services = await createServices();
  const { sessionId, cwd } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });
  fs.mkdirSync(path.join(cwd, "assets"));

  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const res = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/files/upload?path=${encodeURIComponent("assets")}&name=logo.png`,
    payload: raw,
    headers: { "content-type": "application/octet-stream" },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().path).toBe("assets/logo.png");
  expect(fs.readFileSync(path.join(cwd, "assets", "logo.png")).equals(raw)).toBe(true);

  const conflict = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/files/upload?path=${encodeURIComponent("assets")}&name=logo.png`,
    payload: raw,
    headers: { "content-type": "application/octet-stream" },
  });
  expect(conflict.statusCode).toBe(409);

  const traversal = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/files/upload?path=${encodeURIComponent("../../")}&name=evil`,
    payload: raw,
    headers: { "content-type": "application/octet-stream" },
  });
  expect(traversal.statusCode).toBe(400);

  await app.close();
});

it("send types the absolute path into the pane — no newline, no Enter", async () => {
  const services = await createServices();
  const { sessionId, tmuxName } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  const upload = await postUpload(app, sessionId, "shot.png", Buffer.from("img"));
  const name = upload.json().name as string;

  const sent = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/uploads/send`,
    payload: { name },
  });
  expect(sent.statusCode).toBe(200);

  const capture = () =>
    execa("tmux", ["-L", services.config.tmuxSocket, "capture-pane", "-p", "-t", tmuxName], {
      reject: false,
    });
  let text = "";
  for (let i = 0; i < 100; i++) {
    text = (await capture()).stdout;
    if (text.includes(name)) break;
    await sleep(50);
  }
  const line = text.split("\n").find((candidate) => candidate.includes(name)) ?? "";
  // the path is typed verbatim and nothing submits it
  expect(line.trimEnd().endsWith(name)).toBe(true);

  const missing = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/uploads/send`,
    payload: { name: "nope.png" },
  });
  expect(missing.statusCode).toBe(404);

  await app.close();
});

it("killing a session removes its upload buffer; the same body limit surfaces as 413", async () => {
  const services = await createServices();
  const { sessionId } = await createShellSession(services);
  const app = await buildApp(services, { logger: false });

  await postUpload(app, sessionId, "keep.txt", Buffer.from("x"));
  expect(fs.existsSync(bufferDir(services, sessionId))).toBe(true);

  // Fastify's own 4xx pass through the error handler untouched: the default
  // JSON body limit (1MB) is exceeded → 413, previously masked as a 500.
  const oversized = await app.inject({
    method: "PUT",
    url: `/api/sessions/${sessionId}/files/content?path=big.txt`,
    payload: { content: "x".repeat(2 * 1024 * 1024), encoding: "utf8" },
  });
  expect(oversized.statusCode).toBe(413);

  await services.sessions.kill(sessionId);
  expect(fs.existsSync(bufferDir(services, sessionId))).toBe(false);

  await app.close();
});
