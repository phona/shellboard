import type { ZodTypeAny, z } from "zod";
import { httpError } from "../errors.js";

export function parseBody<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw httpError(400, detail);
  }
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  return parseBody(schema, data);
}

export function paramId(request: { params: unknown }): string {
  const params = (request.params ?? {}) as { id?: unknown };
  if (typeof params.id !== "string" || params.id.length === 0) {
    throw httpError(400, "missing :id");
  }
  return params.id;
}

export function queryString(request: { query: unknown }): Record<string, string> {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
