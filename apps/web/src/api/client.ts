import { MAX_UPLOAD_BYTES } from "@shellboard/contracts";
import type {
  Command,
  CreateCommandInput,
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
  UpdateCommandInput,
  UploadList,
} from "@shellboard/contracts";
import { formatSize } from "../util/format.js";
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
  commands: {
    list: () => http<Command[]>("/api/commands"),
    create: (input: CreateCommandInput) =>
      http<Command>("/api/commands", { method: "POST", json: input }),
    update: (id: string, input: UpdateCommandInput) =>
      http<Command>(`/api/commands/${id}`, { method: "PATCH", json: input }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/commands/${id}`, { method: "DELETE" }),
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
  uploads: {
    list: (id: string) => http<UploadList>(`/api/sessions/${id}/uploads`),
    remove: (id: string, name: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/uploads${query({ name })}`, {
        method: "DELETE",
      }),
    send: (id: string, name: string) =>
      http<{ ok: boolean }>(`/api/sessions/${id}/uploads/send`, {
        method: "POST",
        json: { name },
      }),
  },
};

export interface UploadTarget {
  sessionId: string;
  /** Repo-relative directory inside the session cwd; omitted = upload buffer. */
  dir?: string;
}

export interface UploadBinaryOptions {
  onProgress?: (percent: number) => void;
  /** Called with the attempt number and the reason the previous one died. */
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * Mobile networks stall instead of failing: a connection with no new bytes for
 * this long is treated as dead and the attempt is cut short. The watch only
 * covers the send phase — once the body is out, UPLOAD_TIMEOUT_MS takes over,
 * because a slow server is not a stalled upload.
 */
const UPLOAD_STALL_MS = 30_000;
/** Backstop for a body that was sent but whose response never arrived. */
const UPLOAD_TIMEOUT_MS = 900_000;
/** One retry, and only for a failure that never got an HTTP response: the
    buffer lane uniquifies colliding names, so replaying an upload that may
    have landed duplicates the file. */
const UPLOAD_ATTEMPTS = 2;

const oversizeMessage = `file exceeds the ${formatSize(MAX_UPLOAD_BYTES)} upload limit`;

function isTransportFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/** A browser kills an in-flight upload when the page is hidden (locked phone,
    switched app) and reports it as a bare transport failure. */
function pageBackgrounded(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function deviceOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Byte progress of one transfer, carried across attempts: a retry that dies
    before its first progress event still reports how far the file got. */
interface TransferProgress {
  sent: number;
  total: number;
}

/**
 * Why the transport died, from the furthest point the body reached. That byte
 * count is what separates a request that never left the device from one the
 * network cut off — a phone on a weak link looks like the latter, a blocked or
 * misrouted request like the former. An attempt with no progress event at all
 * carries no signal, so it stays plain.
 */
function interruptReason(stalled: boolean, progress: TransferProgress): string {
  if (stalled) return `upload stalled (no progress for ${UPLOAD_STALL_MS / 1000}s)`;
  if (pageBackgrounded()) return "upload interrupted (the app went to the background)";
  if (deviceOffline()) return "network error (device is offline)";
  if (progress.total === 0) return "network error";
  if (progress.sent >= progress.total) return "network error (body sent, no response)";
  if (progress.sent === 0) return "network error (no bytes left the device)";
  return `network error (sent ${formatSize(progress.sent)} of ${formatSize(progress.total)}, connection dropped)`;
}

/** One attempt. Resolves with the server-side name (the buffer lane
    uniquifies collisions). */
function uploadOnce(
  target: UploadTarget,
  file: File,
  options: UploadBinaryOptions,
  progress: TransferProgress,
): Promise<{ name: string }> {
  const search =
    target.dir === undefined
      ? query({ name: file.name })
      : query({ path: target.dir, name: file.name });
  const url =
    target.dir === undefined
      ? `/api/sessions/${target.sessionId}/uploads${search}`
      : `/api/sessions/${target.sessionId}/files/upload${search}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStallWatch = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    const armStallWatch = () => {
      clearStallWatch();
      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };

    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        progress.sent = event.loaded;
        progress.total = event.total;
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        options.onProgress?.(percent);
        // The body is fully out: waiting for the answer is no longer a stall.
        if (percent >= 100) clearStallWatch();
        return;
      }
      armStallWatch();
    };
    // A body small enough to go out in one write may fire no progress event
    // with loaded >= total; upload.onload still fires on success.
    xhr.upload.onload = clearStallWatch;
    xhr.onload = () => {
      clearStallWatch();
      if (xhr.status === 401) {
        useUi.getState().setAuthRequired(true);
        reject(new ApiError(401, "unauthorized"));
        return;
      }
      const body = xhr.response as { error?: string; name?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && typeof body?.name === "string") {
        resolve({ name: body.name });
        return;
      }
      // A body over the limit is answered by the edge with an HTML page,
      // which responseType "json" turns into null: name the limit instead of
      // repeating a status line the user cannot act on.
      if (xhr.status === 413 && body?.error === undefined) {
        reject(new ApiError(413, oversizeMessage));
        return;
      }
      reject(new ApiError(xhr.status, body?.error ?? `${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => {
      clearStallWatch();
      reject(new ApiError(0, interruptReason(stalled, progress)));
    };
    xhr.onabort = () => {
      clearStallWatch();
      // Our own abort (the stall watch) is the only one this code performs.
      reject(new ApiError(0, stalled ? interruptReason(stalled, progress) : "upload canceled"));
    };
    xhr.ontimeout = () => {
      clearStallWatch();
      reject(new ApiError(0, "upload timed out"));
    };
    armStallWatch();
    xhr.send(file);
  });
}

/**
 * Raw binary upload (application/octet-stream) with progress. fetch() has no
 * upload progress, so this is an XMLHttpRequest. Resolves with the final
 * server-side name (the buffer lane uniquifies collisions).
 */
export async function uploadBinary(
  target: UploadTarget,
  file: File,
  options: UploadBinaryOptions = {},
): Promise<{ name: string }> {
  // Refuse locally: sending a body the edge (or the server) will cut off only
  // burns the user's connection to learn what the file size already says.
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, oversizeMessage);
  const progress: TransferProgress = { sent: 0, total: 0 };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await uploadOnce(target, file, options, progress);
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS || !isTransportFailure(error)) throw error;
      // The reason travels with the retry: if the second attempt lands, the
      // first one's failure is otherwise never reported anywhere.
      const reason = error instanceof ApiError ? error.message : "unknown failure";
      options.onRetry?.(attempt + 1, reason);
    }
  }
}

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}
