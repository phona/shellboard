import type { FastifyInstance } from "fastify";
import {
  CreateSessionInputSchema,
  UpdateSessionInputSchema,
} from "@shellboard/contracts";
import type { Services } from "../services.js";
import { paramId, parseBody } from "../http/helpers.js";

export function registerSessionRoutes(app: FastifyInstance, services: Services): void {
  app.get("/api/sessions", async () => {
    return { sessions: services.sessions.list() };
  });

  app.post("/api/sessions", async (request, reply) => {
    const created = await services.sessions.create(
      parseBody(CreateSessionInputSchema, request.body),
    );
    return reply.code(201).send(created);
  });

  app.patch("/api/sessions/:id", async (request) => {
    return services.sessions.rename(
      paramId(request),
      parseBody(UpdateSessionInputSchema, request.body),
    );
  });

  app.delete("/api/sessions/:id", async (request) => {
    await services.sessions.kill(paramId(request));
    return { ok: true };
  });

  app.post("/api/sessions/:id/restart", async (request) => {
    return services.sessions.restart(paramId(request));
  });
}
