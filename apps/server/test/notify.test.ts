import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "../src/app";
import { afterAllCleanup, createServices, FakeWS, makeTempDir, sleep, waitFor } from "./helpers";

afterAllCleanup();

const hooksDir = makeTempDir("shellboard-hooks-");
process.env.SHELLBOARD_NOTIFY_DIR = hooksDir;
process.env.SHELLBOARD_NOTIFY_TIMEOUT_MS = "1000";
process.env.SHELLBOARD_NOTIFY_IDLE_MIN_MS = "1000";

/** A hook that drains stdin and records the payload. `body` runs before the write. */
function writeRecordingHook(name: string, outPath: string, body = ""): string {
  const source = `import { writeFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
${body}
writeFileSync(${JSON.stringify(outPath)}, Buffer.concat(chunks).toString());
`;
  fs.writeFileSync(path.join(hooksDir, name), source);
  return outPath;
}

async function createApp() {
  const services = await createServices();
  const app = await buildApp(services, { logger: false });
  return { services, token: services.config.notifyToken, app };
}

type App = Awaited<ReturnType<typeof createApp>>["app"];

async function createSession(
  app: App,
  cwd: string,
  agentType: "shell" | "custom" = "shell",
): Promise<{ id: string; tmuxName: string }> {
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "notify", rootPath: cwd },
  });
  expect(projectRes.statusCode).toBe(201);
  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload:
      agentType === "custom"
        ? { projectId: projectRes.json().id, name: "notify-session", agentType, command: "bash" }
        : { projectId: projectRes.json().id, name: "notify-session", agentType },
  });
  expect(sessionRes.statusCode).toBe(201);
  const { id, tmuxName } = sessionRes.json().session;
  return { id, tmuxName };
}

it("requires the notify token and a valid payload", async () => {
  const { app, token } = await createApp();

  const noAuth = await app.inject({ method: "POST", url: "/api/notify", payload: { title: "x" } });
  expect(noAuth.statusCode).toBe(401);

  const badAuth = await app.inject({
    method: "POST",
    url: "/api/notify",
    headers: { authorization: "Bearer wrong-token" },
    payload: { title: "x" },
  });
  expect(badAuth.statusCode).toBe(401);

  const badBody = await app.inject({
    method: "POST",
    url: "/api/notify",
    headers: { authorization: `Bearer ${token}` },
    payload: { body: "no title" },
  });
  expect(badBody.statusCode).toBe(400);

  await app.close();
});

it("broadcasts session.notify and runs hooks with the enriched payload", async () => {
  const { app, services, token } = await createApp();
  const cwd = makeTempDir();
  const { id } = await createSession(app, cwd);

  const bus = new FakeWS();
  services.bus.add(bus.asWebSocket());

  const outPath = writeRecordingHook("record.mjs", path.join(hooksDir, "out-session.json"));
  const res = await app.inject({
    method: "POST",
    url: "/api/notify",
    headers: { authorization: `Bearer ${token}` },
    payload: { title: "task done", body: "3 files changed", level: "success", sessionId: id },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ ok: true, sessionId: id });

  await waitFor(() => fs.existsSync(outPath));
  const hookPayload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  expect(hookPayload).toEqual({
    type: "session.notify",
    title: "task done",
    body: "3 files changed",
    level: "success",
    at: expect.any(Number),
    session: { id, name: "notify-session", agentType: "shell", cwd },
  });

  // the web UI receives exactly the same event
  await waitFor(() => bus.text.length > 0);
  expect(JSON.parse(bus.text[0] ?? "{}")).toEqual(hookPayload);

  await app.close();
});

it("attributes events arriving with a tmux pane id", async () => {
  const { app, services, token } = await createApp();
  const cwd = makeTempDir();
  const { id, tmuxName } = await createSession(app, cwd);

  const panes = await execa(
    "tmux",
    ["-L", services.config.tmuxSocket, "list-panes", "-t", tmuxName, "-F", "#{pane_id}"],
  );
  const pane = panes.stdout.trim().split("\n")[0];
  expect(pane).toMatch(/^%/);

  const outPath = writeRecordingHook("pane.mjs", path.join(hooksDir, "out-pane.json"));
  const res = await app.inject({
    method: "POST",
    url: "/api/notify",
    headers: { authorization: `Bearer ${token}` },
    payload: { title: "done via pane", pane },
  });
  expect(res.statusCode).toBe(202);

  await waitFor(() => fs.existsSync(outPath));
  const hookPayload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  expect(hookPayload.session).toEqual({ id, name: "notify-session", agentType: "shell", cwd });

  await app.close();
});

it("keeps serving when hooks fail, hang, or are disabled", async () => {
  const { app, token } = await createApp();

  writeRecordingHook("good.mjs", path.join(hooksDir, "out-good.json"));
  // failing hook: exits before writing anything
  writeRecordingHook("fail.mjs", path.join(hooksDir, "out-fail.json"), "process.exit(3);");
  // hanging hook: killed by the server after SHELLBOARD_NOTIFY_TIMEOUT_MS
  const hangStart = path.join(hooksDir, "hang-started");
  const hangName = `hang-probe-${process.pid}.mjs`;
  fs.writeFileSync(
    path.join(hooksDir, hangName),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(hangStart)}, "x");
// hold the event loop so only the server's SIGKILL can end this process
setInterval(() => {}, 1000);
`,
  );
  // disabled hooks are skipped
  const disabledOut = writeRecordingHook(
    "dead.disabled.mjs",
    path.join(hooksDir, "out-disabled.json"),
  );

  const res = await app.inject({
    method: "POST",
    url: "/api/notify",
    headers: { authorization: `Bearer ${token}` },
    payload: { title: "mixed hooks" },
  });
  expect(res.statusCode).toBe(202);

  await waitFor(() => fs.existsSync(path.join(hooksDir, "out-good.json")));
  await waitFor(() => fs.existsSync(hangStart));

  // the hung node process is reaped by the hook timeout
  let alive = true;
  for (let i = 0; i < 60; i++) {
    const probe = await execa("pgrep", ["-f", hangName], { reject: false });
    alive = probe.exitCode === 0;
    if (!alive) break;
    await sleep(200);
  }
  expect(alive).toBe(false);

  // disabled files never run
  await sleep(200);
  expect(fs.existsSync(disabledOut)).toBe(false);

  // a failing hook never takes the server down
  const health = await app.inject({ method: "GET", url: "/api/sessions" });
  expect(health.statusCode).toBe(200);

  await app.close();
});

it("fires hooks on a working→idle transition, gated by phase and attachment", async () => {
  const { app, services } = await createApp();
  const cwd = makeTempDir();
  const { id, tmuxName } = await createSession(app, cwd, "custom");
  const outPath = writeRecordingHook("idle.mjs", path.join(hooksDir, "out-idle.json"));
  const observe = (activitySeconds: number, attached = 0): void =>
    services.tracker.observe(id, { name: tmuxName, activitySeconds, attached });

  // phase starts (exited → working), lasts past the minimum, then goes idle
  observe(1);
  await sleep(1100);
  observe(11);
  await waitFor(() => fs.existsSync(outPath));
  const fired = JSON.parse(fs.readFileSync(outPath, "utf8"));
  expect(fired.title).toBe("notify-session is now idle");
  expect(fired.session).toEqual({ id, name: "notify-session", agentType: "custom", cwd });

  // attached terminal still fires: an open tab holds the PTY for hours
  // without anyone watching — watching is the browser notification's concern
  observe(1);
  services.tracker.setAttached(id, true);
  await sleep(1100);
  observe(11);
  await waitFor(() => {
    const current = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return current.at !== fired.at;
  });
  services.tracker.setAttached(id, false);

  // too-short phase: a blip, not a finished task — no push
  const afterAttached = fs.readFileSync(outPath, "utf8");
  observe(1);
  observe(11);
  await sleep(300);
  expect(fs.readFileSync(outPath, "utf8")).toEqual(afterAttached);

  // interactive shell sessions never push
  const shell = await createSession(app, cwd, "shell");
  services.tracker.observe(shell.id, { name: shell.tmuxName, activitySeconds: 1, attached: 0 });
  await sleep(1100);
  services.tracker.observe(shell.id, { name: shell.tmuxName, activitySeconds: 11, attached: 0 });
  await sleep(300);
  expect(fs.readFileSync(outPath, "utf8")).toEqual(afterAttached);

  await app.close();
});
