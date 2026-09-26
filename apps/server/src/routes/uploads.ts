import type { FastifyInstance } from "fastify";
import {
  SendUploadInputSchema,
  UploadQuerySchema,
} from "@shellboard/contracts";
import type { Services } from "../services.js";
import { httpError } from "../errors.js";
import { paramId, parseBody, parseQuery, queryString } from "../http/helpers.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Upload buffer lane: ~/.shellboard/uploads/<sessionId>/ (D1 second root). */
export function registerUploadRoutes(app: FastifyInstance, services: Services): void {
  const binaryBody = (body: unknown): Buffer => {
    if (!Buffer.isBuffer(body)) throw httpError(400, "expected an application/octet-stream body");
    if (body.length === 0) throw httpError(400, "empty upload");
    return body;
  };

  app.post(
    "/api/sessions/:id/uploads",
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const id = paramId(request);
      services.sessions.get(id);
      const { name } = parseQuery(UploadQuerySchema, queryString(request));
      const entry = services.uploads.upload(id, name, binaryBody(request.body));
      return reply.code(201).send(entry);
    },
  );

  app.get("/api/sessions/:id/uploads", async (request) => {
    return services.uploads.list(paramId(request));
  });

  app.delete("/api/sessions/:id/uploads", async (request) => {
    const id = paramId(request);
    const { name } = parseQuery(UploadQuerySchema, queryString(request));
    services.uploads.remove(id, name);
    return { ok: true };
  });

  app.post("/api/sessions/:id/uploads/send", async (request) => {
    const id = paramId(request);
    const { name } = parseBody(SendUploadInputSchema, request.body);
    const absolute = services.uploads.absolutePath(id, name);
    const session = services.sessions.get(id);
    await services.tmux.sendText(session.tmuxName, absolute);
    return { ok: true };
  });
}
