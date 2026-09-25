import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { Services } from "./services.js";
import { HttpError } from "./errors.js";
import { registerAuth } from "./auth.js";
import { attachWsHub } from "./terminal/wsHub.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerFileRoutes } from "./routes/files.js";

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

  await registerAuth(app, services.config);
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerGitRoutes(app, services);
  registerFileRoutes(app, services);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
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
        services.tools.handle(ws, services.sessions.get(toolMatch[1] ?? "").cwd);
      } catch {
        ws.close(1008, "session not found");
      }
      return;
    }
    ws.close(1008, "unknown endpoint");
  });

  return app;
}
