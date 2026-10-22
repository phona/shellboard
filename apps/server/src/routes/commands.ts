import type { FastifyInstance } from "fastify";
import {
  CreateCommandInputSchema,
  UpdateCommandInputSchema,
} from "@shellboard/contracts";
import type { Services } from "../services.js";
import { paramId, parseBody } from "../http/helpers.js";

export function registerCommandRoutes(app: FastifyInstance, services: Services): void {
  app.get("/api/commands", async () => {
    return services.commands.list();
  });

  app.post("/api/commands", async (request, reply) => {
    const created = services.commands.create(
      parseBody(CreateCommandInputSchema, request.body),
    );
    return reply.code(201).send(created);
  });

  app.patch("/api/commands/:id", async (request) => {
    return services.commands.update(
      paramId(request),
      parseBody(UpdateCommandInputSchema, request.body),
    );
  });

  app.delete("/api/commands/:id", async (request) => {
    services.commands.remove(paramId(request));
    return { ok: true };
  });
}
