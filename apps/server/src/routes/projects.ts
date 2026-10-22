import type { FastifyInstance } from "fastify";
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
} from "@shellboard/contracts";
import type { Services } from "../services.js";
import { paramId, parseBody } from "../http/helpers.js";

export function registerProjectRoutes(app: FastifyInstance, services: Services): void {
  app.get("/api/projects", async () => {
    return services.projects.list();
  });

  app.post("/api/projects", async (request, reply) => {
    const input = parseBody(CreateProjectInputSchema, request.body);
    const project = services.projects.create(input);
    return reply.code(201).send(project);
  });

  app.patch("/api/projects/:id", async (request) => {
    const id = paramId(request);
    const input = parseBody(UpdateProjectInputSchema, request.body);
    return services.projects.update(id, input);
  });

  app.delete("/api/projects/:id", async (request) => {
    services.projects.remove(paramId(request));
    return { ok: true };
  });
}
