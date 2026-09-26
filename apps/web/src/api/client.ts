import type {
  CreateFileInput,
  CreateProjectInput,
  CreateSessionInput,
  DirectoryListing,
  FileContent,
  FileEntry,
  FileList,
  GitDiff,
  GitStatus,
  Project,
  SaveFileInput,
  Session,
  SessionWithRuntime,
} from "@shellboard/contracts";
import { useUi } from "../state/store.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function http<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers: {
        ...(rest.headers ?? {}),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    throw new ApiError(0, `network error: ${String(err)}`);
  }
  if (response.status === 401) {
    useUi.getState().setAuthRequired(true);
    throw new ApiError(401, "unauthorized");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data.error === "string") message = data.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export const api = {
  auth: {
    login: (token: string) =>
      http<{ ok: boolean }>("/api/auth/login", { method: "POST", json: { token } }),
  },
  projects: {
    list: () => http<Project[]>("/api/projects"),
    create: (input: CreateProjectInput) =>
      http<Project>("/api/projects", { method: "POST", json: input }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  },
  sessions: {
    list: () => http<{ sessions: SessionWithRuntime[] }>("/api/sessions"),
    create: (input: CreateSessionInput) =>
      http<SessionWithRuntime>("/api/sessions", { method: "POST", json: input }),
    rename: (id: string, name: string) =>
      http<Session>(`/api/sessions/${id}`, { method: "PATCH", json: { name } }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
    restart: (id: string) =>
      http<SessionWithRuntime>(`/api/sessions/${id}/restart`, { method: "POST" }),
  },
  git: {
    status: (id: string) => http<GitStatus>(`/api/sessions/${id}/git/status`),
    diff: (id: string, opts: { path?: string; staged?: boolean } = {}) =>
      http<GitDiff>(
        `/api/sessions/${id}/git/diff${query({ path: opts.path, staged: opts.staged ? "1" : undefined })}`,
      ),
    stage: (id: string, path: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/git/stage`, {
        method: "POST",
        json: { path },
      }),
    unstage: (id: string, path: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/git/unstage`, {
        method: "POST",
        json: { path },
      }),
    discard: (id: string, path: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/git/discard`, {
        method: "POST",
        json: { path },
      }),
  },
  fs: {
    directories: (path?: string) =>
      http<DirectoryListing>(`/api/fs/directories${query({ path })}`),
  },
  files: {
    list: (id: string, path = ".") =>
      http<FileList>(`/api/sessions/${id}/files${query({ path })}`),
    content: (id: string, path: string) =>
      http<FileContent>(`/api/sessions/${id}/files/content${query({ path })}`),
    save: (id: string, path: string, input: SaveFileInput) =>
      http<{ mtime: number }>(`/api/sessions/${id}/files/content${query({ path })}`, {
        method: "PUT",
        json: input,
      }),
    create: (id: string, input: CreateFileInput) =>
      http<FileEntry>(`/api/sessions/${id}/files`, { method: "POST", json: input }),
    rename: (id: string, path: string, newName: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/files`, {
        method: "PATCH",
        json: { path, newName },
      }),
    remove: (id: string, path: string, recursive: boolean) =>
      http<{ ok: boolean }>(
        `/api/sessions/${id}/files${query({ path, recursive: recursive ? "1" : undefined })}`,
        { method: "DELETE" },
      ),
    downloadUrl: (id: string, path: string) =>
      `/api/sessions/${id}/files/download${query({ path })}`,
  },
};

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}
