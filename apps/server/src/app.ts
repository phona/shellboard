import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { Services } from "./services.js";
import { HttpError } from "./errors.js";
import { registerAuth } from "./auth.js";
import { attachWsHub } from "./terminal/wsHub.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerCommandRoutes } from "./routes/commands.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerNotifyRoutes } from "./routes/notify.js";

export interface BuildAppOptions {
  logger: boolean;
}

export async function buildApp(
  services: Services,
  options: BuildAppOptions,
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: options.logger ? { level: process.env.SHELLBOARD_LOG_LEVEL ?? "info" } : false,
  });

  // Binary uploads POST the raw file as application/octet-stream (no
  // multipart dependency). Per-route bodyLimit caps each upload at
  // MAX_UPLOAD_BYTES (see contracts); the global JSON limit stays at
  // Fastify's default.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  await registerAuth(app, services.config);
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerCommandRoutes(app, services);
  registerGitRoutes(app, services);
  registerFileRoutes(app, services);
  registerUploadRoutes(app, services);
  registerFsRoutes(app);
  registerNotifyRoutes(app, services);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    // Fastify's own 4xx (body-too-large 413, validation 400, …) carry a
    // safe message and must not be masked as a generic 500.
    const framed = error as { statusCode?: unknown; message?: unknown };
    if (
      typeof framed.statusCode === "number" &&
      framed.statusCode >= 400 &&
      framed.statusCode < 500 &&
      typeof framed.message === "string"
    ) {
      return reply.code(framed.statusCode).send({ error: framed.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal error" });
  });

  const hasStatic = fs.existsSync(services.config.webDist);
  if (hasStatic) {
    await app.register(fastifyStatic, {
      root: services.config.webDist,
      wildcard: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith("/api/");
    if (!isApi && (request.method === "GET" || request.method === "HEAD") && hasStatic) {
      // Real files (hashed assets, fonts) serve as-is; only misses fall back
      // to the SPA entry. Without the existence check, sendFile("index.html")
      // would answer every asset request with HTML.
      const pathname = new URL(request.url, "http://localhost").pathname;
      const decoded = decodeURIComponent(pathname);
      const file = path.resolve(services.config.webDist, `.${path.posix.normalize(`/${decoded}`)}`);
      if (
        file.startsWith(services.config.webDist + path.sep) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile()
      ) {
        return reply.sendFile(decoded);
      }
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });

  attachWsHub(app.server, services.config, (pathname, ws) => {
    if (pathname === "/api/events") {
      services.bus.add(ws);
      return;
    }
    const terminalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/terminal$/);
    if (terminalMatch) {
      try {
        services.bridge.attach(ws, services.sessions.get(terminalMatch[1] ?? ""));
      } catch {
        ws.close(1008, "session not found");
      }
      return;
    }
    const toolMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tools\/terminal$/);
    if (toolMatch) {
      try {
        const session = services.sessions.get(toolMatch[1] ?? "");
        const project = services.projects.get(session.projectId);
        if (project.location.kind === "ssh") {
          ws.close(1008, "remote tool terminal is not supported yet");
          return;
        }
        services.tools.handle(ws, session.cwd);
      } catch {
        ws.close(1008, "session not found");
      }
      return;
    }
    ws.close(1008, "unknown endpoint");
  });

  return app;
}
