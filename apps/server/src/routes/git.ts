import type { FastifyInstance } from "fastify";
import { GitActionInputSchema, GitDiffQuerySchema } from "@shellboard/contracts";
import type { Services } from "../services.js";
import { httpError } from "../errors.js";
import { paramId, parseBody, parseQuery, queryString } from "../http/helpers.js";

export function registerGitRoutes(app: FastifyInstance, services: Services): void {
  const localCwdOf = (id: string): string => {
    const session = services.sessions.get(id);
    if (services.projects.get(session.projectId).location.kind === "ssh") {
      throw httpError(501, "remote git is not supported yet");
    }
    return session.cwd;
  };
  const notifyChange = (projectId: string) => {
    services.bus.publish({ type: "git.status_changed", projectId });
  };

  app.get("/api/sessions/:id/git/status", async (request) => {
    return services.git.status(localCwdOf(paramId(request)));
  });

  app.get("/api/sessions/:id/git/diff", async (request) => {
    const query = parseQuery(GitDiffQuerySchema, queryString(request));
    return {
      text: await services.git.diff(localCwdOf(paramId(request)), {
        staged: query.staged,
        path: query.path ?? null,
      }),
    };
  });

  app.post("/api/sessions/:id/git/stage", async (request) => {
    const id = paramId(request);
    const { path } = parseBody(GitActionInputSchema, request.body);
    await services.git.stage(localCwdOf(id), path);
    notifyChange(services.sessions.get(id).projectId);
    return { ok: true };
  });

  app.post("/api/sessions/:id/git/unstage", async (request) => {
    const id = paramId(request);
    const { path } = parseBody(GitActionInputSchema, request.body);
    await services.git.unstage(localCwdOf(id), path);
    notifyChange(services.sessions.get(id).projectId);
    return { ok: true };
  });

  app.post("/api/sessions/:id/git/discard", async (request) => {
    const id = paramId(request);
    const { path } = parseBody(GitActionInputSchema, request.body);
    const cwd = localCwdOf(id);
    const status = await services.git.status(cwd);
    const entry = status.entries.find(
      (candidate) => candidate.path === path || candidate.origPath === path,
    );
    if (!entry) throw httpError(404, "changed file not found in git status");
    await services.git.discard(cwd, entry);
    notifyChange(services.sessions.get(id).projectId);
    return { ok: true };
  });
}
