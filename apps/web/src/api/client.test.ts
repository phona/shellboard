import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, uploadBinary, wsUrl } from "./client";

/** A fetch stand-in that records the call and answers with a canned response. */
function stubFetch(answer: { status?: number; body?: unknown; statusText?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: answer.statusText ?? "OK",
      json: async () => answer.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http", () => {
  it("sends a JSON body with the matching content type", async () => {
    const { calls } = stubFetch({ body: { ok: true } });
    await api.projects.create({ name: "p", rootPath: "/tmp" });
    expect(calls[0]!.url).toBe("/api/projects");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "p", rootPath: "/tmp" }));
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("leaves a bodyless request alone", async () => {
    const { calls } = stubFetch({ body: [] });
    await api.projects.list();
    expect(calls[0]!.init.method).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
  });

  it("returns the parsed body on success", async () => {
    stubFetch({ body: { sessions: [] } });
    await expect(api.sessions.list()).resolves.toEqual({ sessions: [] });
  });

  it("turns a network failure into a status-0 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(api.projects.list()).rejects.toMatchObject({ status: 0 });
    await expect(api.projects.list()).rejects.toThrow(/network error/);
  });

  it("prefers the server's error message over the status line", async () => {
    stubFetch({ status: 409, statusText: "Conflict", body: { error: "name taken" } });
    await expect(api.projects.create({ name: "p", rootPath: "/tmp" })).rejects.toMatchObject({
      status: 409,
      message: "name taken",
    });
  });

  it("falls back to the status line for a non-JSON error body", async () => {
    stubFetch({ status: 500, statusText: "Server Error", body: undefined });
    // A body that is not JSON: json() rejects, so the message must survive it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: async () => {
          throw new SyntaxError("not json");
        },
      }) as unknown as Response),
    );
    await expect(api.projects.list()).rejects.toMatchObject({
      status: 500,
      message: "500 Server Error",
    });
  });

  it("flags the store when the server says 401", async () => {
    stubFetch({ status: 401, body: {} });
    const { useUi } = await import("../state/store.js");
    useUi.setState({ authRequired: false });
    await expect(api.projects.list()).rejects.toMatchObject({ status: 401 });
    expect(useUi.getState().authRequired).toBe(true);
  });
});

describe("query", () => {
  it("omits undefined values rather than sending the string", async () => {
    const { calls } = stubFetch({ body: {} });
    await api.files.list("s1", ".");
    expect(calls[0]!.url).toBe("/api/sessions/s1/files?path=.");
  });

  it("encodes values that need it", async () => {
    const { calls } = stubFetch({ body: {} });
    await api.files.content("s1", "a b&c.txt");
    expect(calls[0]!.url).toContain("path=a+b%26c.txt");
  });

  it("builds no query string at all when everything is undefined", async () => {
    const { calls } = stubFetch({ body: {} });
    await api.fs.directories();
    expect(calls[0]!.url).toBe("/api/fs/directories");
  });

  it("drops a false flag instead of sending recursive=0", async () => {
    const { calls } = stubFetch({ body: { ok: true } });
    await api.files.remove("s1", "a", false);
    expect(calls[0]!.url).toBe("/api/sessions/s1/files?path=a");
  });
});

describe("downloadUrl", () => {
  it("is a plain path with the query attached", () => {
    expect(api.files.downloadUrl("s1", "a.txt")).toBe("/api/sessions/s1/files/download?path=a.txt");
  });
});

describe("ApiError", () => {
  it("carries the status and reads as an Error", () => {
    const err = new ApiError(404, "not found");
    expect(err.status).toBe(404);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("not found");
  });
});

describe("wsUrl", () => {
  it("picks the scheme from the page protocol", () => {
    const location = { protocol: "https:", host: "example.test" };
    vi.stubGlobal("window", { location });
    expect(wsUrl("/api/x")).toBe("wss://example.test/api/x");
    location.protocol = "http:";
    expect(wsUrl("/api/x")).toBe("ws://example.test/api/x");
  });
});

describe("uploadBinary", () => {
  /** Minimal XMLHttpRequest double. The code assigns onload/onerror/upload
      .onprogress and then calls send(), so capturing those three is enough. */
  function stubXhr(behaviour: { status?: number; response?: unknown; fail?: boolean } = {}): {
    progress: (event: { lengthComputable: boolean; total: number; loaded: number }) => void;
    opened: string[];
  } {
    const opened: string[] = [];
    let onProgress: ((event: unknown) => void) | undefined;
    const upload: Record<string, unknown> = {};
    Object.defineProperty(upload, "onprogress", {
      set: (fn) => {
        onProgress = fn as (event: unknown) => void;
      },
      get: () => onProgress,
    });
    class FakeXhr {
      upload = upload;
      status = behaviour.status ?? 200;
      statusText = "OK";
      response = behaviour.response;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open(_method: string, url: string): void {
        opened.push(url);
      }
      setRequestHeader(): void {}
      send(): void {
        if (behaviour.fail) this.onerror?.();
        else this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    return { progress: (event) => onProgress?.(event), opened };
  }

  const file = () => new File(["x"], "a.txt");

  it("resolves with the server-side name", async () => {
    stubXhr({ response: { name: "buffer/1-a.txt" } });
    await expect(uploadBinary({ sessionId: "s1" }, file())).resolves.toEqual({
      name: "buffer/1-a.txt",
    });
  });

  it("reports progress as a whole percentage", async () => {
    const xhr = stubXhr({ response: { name: "n" } });
    const seen: number[] = [];
    const done = uploadBinary({ sessionId: "s1" }, file(), (p) => seen.push(p));
    xhr.progress({ lengthComputable: true, total: 100, loaded: 25 });
    xhr.progress({ lengthComputable: true, total: 100, loaded: 100 });
    await done;
    expect(seen).toEqual([25, 100]);
  });

  it("clamps progress past 100 instead of reporting an impossible value", async () => {
    const xhr = stubXhr({ response: { name: "n" } });
    const seen: number[] = [];
    const done = uploadBinary({ sessionId: "s1" }, file(), (p) => seen.push(p));
    xhr.progress({ lengthComputable: true, total: 10, loaded: 40 });
    await done;
    expect(seen).toEqual([100]);
  });

  it("ignores a progress event with no computable total", async () => {
    const xhr = stubXhr({ response: { name: "n" } });
    const seen: number[] = [];
    const done = uploadBinary({ sessionId: "s1" }, file(), (p) => seen.push(p));
    xhr.progress({ lengthComputable: false, total: 0, loaded: 5 });
    await done;
    expect(seen).toEqual([]);
  });

  it("rejects with the server's error message", async () => {
    stubXhr({ status: 413, response: { error: "too large" } });
    await expect(uploadBinary({ sessionId: "s1" }, file())).rejects.toMatchObject({
      status: 413,
      message: "too large",
    });
  });

  it("rejects with the status line when the body carries no error field", async () => {
    stubXhr({ status: 500, response: {} });
    await expect(uploadBinary({ sessionId: "s1" }, file())).rejects.toMatchObject({ status: 500 });
  });

  it("turns a transport failure into a status-0 ApiError", async () => {
    stubXhr({ fail: true });
    await expect(uploadBinary({ sessionId: "s1" }, file())).rejects.toMatchObject({ status: 0 });
  });

  it("routes a buffer upload to uploads and a directory upload to files", async () => {
    const xhr = stubXhr({ response: { name: "n" } });
    await uploadBinary({ sessionId: "s1" }, file());
    await uploadBinary({ sessionId: "s1", dir: "docs" }, file());
    expect(xhr.opened[0]).toBe("/api/sessions/s1/uploads?name=a.txt");
    expect(xhr.opened[1]).toBe("/api/sessions/s1/files/upload?path=docs&name=a.txt");
  });
});
