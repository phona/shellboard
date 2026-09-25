import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  CreateFileInputSchema,
  RenameFileInputSchema,
  SaveFileInputSchema,
} from "@shellboard/contracts";
import type { Services } from "../services.js";
import { httpError } from "../errors.js";
import { paramId, parseBody, queryString } from "../http/helpers.js";

function requiredPath(request: { query: unknown }): string {
  const query = queryString(request);
  const value = query["path"];
  if (value === undefined || value.length === 0) {
    throw httpError(400, "missing ?path");
  }
  return value;
}

export function registerFileRoutes(app: FastifyInstance, services: Services): void {
  const cwdOf = (id: string) => services.sessions.get(id).cwd;
  const notifyChange = (projectId: string) => {
    services.bus.publish({ type: "git.status_changed", projectId });
  };

  app.get("/api/sessions/:id/files", async (request) => {
    const query = queryString(request);
    return services.files.list(cwdOf(paramId(request)), query["path"] ?? ".");
  });

  app.get("/api/sessions/:id/files/content", async (request) => {
    return services.files.content(cwdOf(paramId(request)), requiredPath(request));
  });

  app.put("/api/sessions/:id/files/content", async (request) => {
    const id = paramId(request);
    const result = services.files.save(
      cwdOf(id),
      requiredPath(request),
      parseBody(SaveFileInputSchema, request.body),
    );
    notifyChange(services.sessions.get(id).projectId);
    return result;
  });

  app.get("/api/sessions/:id/files/download", async (request, reply) => {
    const id = paramId(request);
    const relPath = requiredPath(request);
    const data = services.files.readRaw(cwdOf(id), relPath);
    return reply
      .type("application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename="${path.basename(relPath)}"`,
      )
      .send(data);
  });

  app.post("/api/sessions/:id/files", async (request, reply) => {
    const id = paramId(request);
    const entry = services.files.create(
      cwdOf(id),
      parseBody(CreateFileInputSchema, request.body),
    );
    notifyChange(services.sessions.get(id).projectId);
    return reply.code(201).send(entry);
  });

  app.patch("/api/sessions/:id/files", async (request) => {
    const id = paramId(request);
    const { path: relPath, newName } = parseBody(RenameFileInputSchema, request.body);
    services.files.rename(cwdOf(id), relPath, newName);
    notifyChange(services.sessions.get(id).projectId);
    return { ok: true };
  });

  app.delete("/api/sessions/:id/files", async (request) => {
    const id = paramId(request);
    const query = queryString(request);
    services.files.remove(
      cwdOf(id),
      requiredPath(request),
      query["recursive"] === "1",
    );
    notifyChange(services.sessions.get(id).projectId);
    return { ok: true };
  });
}
