import type { FastifyInstance } from "fastify";
import { NotifyInputSchema } from "@shellboard/contracts";
import { notifyTokenAuthorized } from "../auth.js";
import { parseBody } from "../http/helpers.js";
import type { Services } from "../services.js";

export function registerNotifyRoutes(app: FastifyInstance, services: Services): void {
  app.post("/api/notify", async (request, reply) => {
    // With cookie auth enabled the global auth hook already gated this route
    // (cookie or notify-token bearer); with it off, the notify token is still
    // required — a notify event triggers the user's hook scripts, so an
    // unauthenticated drive-by POST must not be able to fire them.
    if (!services.config.token && !notifyTokenAuthorized(request, services.config)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const input = parseBody(NotifyInputSchema, request.body);
    const result = await services.notifier.notify(input);
    // accepted immediately; hook runs continue in the background
    return reply.code(202).send({ ok: true, sessionId: result.session?.id ?? null });
  });
}
