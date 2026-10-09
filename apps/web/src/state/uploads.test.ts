import { beforeEach, describe, expect, it, vi } from "vitest";

/** uploads orchestrates uploadBinary + api.uploads.send + toast. Both seams are
    mocked so the test can drive the queue deterministically. */
const uploadBinary = vi.fn();
const send = vi.fn();
const toast = vi.fn();
const prepareUpload = vi.fn();
const resizeSummary = vi.fn();

// Shape-compatible stand-in for the real ApiError: the code only reads
// `.status` and `.message` to decide which toast to show. Written out longhand
// because tsconfig forbids parameter properties.
class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

vi.mock("../api/client.js", () => ({
  ApiError: FakeApiError,
  uploadBinary: (...args: unknown[]) => uploadBinary(...args),
  api: {
    uploads: {
      send: (...args: unknown[]) => send(...args),
    },
  },
}));

vi.mock("./toasts.js", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

// The resize seam is fully stubbed: what the re-encode does to the bytes is
// covered in util/imageUpload.test.ts. This file owns only the queue, the
// phase the pill shows, and the copy the user reads.
vi.mock("../util/imageUpload.js", () => ({
  prepareUpload: (...args: unknown[]) => prepareUpload(...args),
  resizeSummary: (...args: unknown[]) => resizeSummary(...args),
}));

const { useUploads } = await import("./uploads");

beforeEach(() => {
  uploadBinary.mockReset();
  send.mockReset();
  toast.mockReset();
  prepareUpload.mockReset();
  prepareUpload.mockImplementation(async (file: File) => ({ file, resizedFrom: null }));
  resizeSummary.mockReset();
  resizeSummary.mockReturnValue(null);
  useUploads.setState({ tasks: [] });
});

const file = (name: string) => new File([name], name);
/** Let the queue's async body run: it awaits each upload in turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the task list", () => {
  it("adds a task per file and removes it when the file is done", async () => {
    uploadBinary.mockResolvedValue({ name: "n" });
    const started = useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    // Synchronously visible before the first await resolves.
    expect(useUploads.getState().tasks.map((t) => [t.name, t.percent])).toEqual([["a", 0]]);
    await started;
    await settle();
    expect(useUploads.getState().tasks).toEqual([]);
  });

  it("shows one task per file, not one for the batch", async () => {
    uploadBinary.mockResolvedValue({ name: "n" });
    const done = useUploads.getState().start({
      sessionId: "s1",
      files: [file("a"), file("b")],
    });
    expect(useUploads.getState().tasks.map((t) => t.name)).toEqual(["a"]);
    await done;
    await settle();
  });

  it("keeps the task on the list while the file is compressed", async () => {
    // Held open: the pill must still read "compressing" during the re-encode,
    // otherwise the UI looks dead for the several hundred ms it takes.
    let release: (() => void) | undefined;
    prepareUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ file: file("a"), resizedFrom: null });
        }),
    );
    const done = useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    expect(useUploads.getState().tasks.map((t) => [t.name, t.phase])).toEqual([["a", "compressing"]]);

    release!();
    await done;
    await settle();
    expect(useUploads.getState().tasks).toEqual([]);
  });

  it("reports progress from the upload callback", async () => {
    let report: ((p: number) => void) | undefined;
    let finish: (() => void) | undefined;
    // Held open: the task must still be on the list while progress arrives,
    // otherwise the store has already dropped it in its finally block.
    uploadBinary.mockImplementation((_target, _file, options) => {
      report = options.onProgress;
      return new Promise((resolve) => {
        finish = () => resolve({ name: "n" });
      });
    });
    const done = useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    report?.(40);
    report?.(80);
    expect(useUploads.getState().tasks.map((t) => t.percent)).toEqual([80]);
    finish!();
    await done;
    await settle();
    expect(useUploads.getState().tasks).toEqual([]);
  });
});

describe("toasts", () => {
  it("offers Send for a buffer upload, which types the path into the shell", async () => {
    uploadBinary.mockResolvedValue({ name: "buffer/1-a.txt" });
    send.mockResolvedValue({ ok: true });
    await useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();

    const call = toast.mock.calls.find((c) => c[0] === "buffer/1-a.txt uploaded");
    expect(call).toBeDefined();
    const action = call![2] as { label: string; onClick(): void };
    expect(action.label).toBe("Send");

    action.onClick();
    await settle();
    expect(send).toHaveBeenCalledWith("s1", "buffer/1-a.txt");
    expect(toast.mock.calls.map((c) => c[0])).toContain("path sent to terminal");
  });

  it("does not offer Send for a repo-directory upload", async () => {
    uploadBinary.mockResolvedValue({ name: "docs/a.txt" });
    await useUploads.getState().start({
      sessionId: "s1",
      dir: "docs",
      files: [file("a")],
    });
    await settle();
    expect(toast.mock.calls.map((c) => c[0])).toEqual(["docs/a.txt uploaded"]);
  });

  it("offers the untouched original when it re-encoded the file", async () => {
    const original = new File(["x"], "IMG_0001.JPG", { type: "image/jpeg" });
    Object.defineProperty(original, "size", { value: 5 * 1024 * 1024 });
    prepareUpload.mockImplementation(async (file: File) => ({
      file: new File([new Uint8Array(480 * 1024)], file.name, { type: "image/jpeg" }),
      resizedFrom: { name: file.name, size: 5 * 1024 * 1024 },
    }));
    resizeSummary.mockReturnValue("5.0 MB → 480.0 KB");
    uploadBinary.mockImplementation(async (_target: unknown, file: File) => ({
      name: file.name,
    }));
    send.mockResolvedValue({ ok: true });

    await useUploads.getState().start({ sessionId: "s1", files: [original] });
    await settle();
    const call = toast.mock.calls.find((c) => String(c[0]).includes("compressed"));
    expect(call).toBeDefined();
    const action = call![2] as { label: string; onClick(): void };
    expect(action.label).toBe("send original");

    action.onClick();
    await settle();
    // The second PUT carries the untouched file, and the pane gets the buffer
    // path of that copy (the lane uniquifies the colliding name).
    expect(uploadBinary).toHaveBeenLastCalledWith({ sessionId: "s1" }, original);
    expect(send).toHaveBeenCalledWith("s1", "IMG_0001.JPG");
    expect(toast.mock.calls.map((c) => c[0])).toContain("path sent to terminal");
  });

  it("says what the re-encode did when it actually shrank the file", async () => {
    prepareUpload.mockImplementation(async (original: File) => ({
      file: new File([new Uint8Array(480 * 1024)], original.name, { type: "image/jpeg" }),
      resizedFrom: { name: original.name, size: 5 * 1024 * 1024 },
    }));
    resizeSummary.mockReturnValue("5.0 MB → 480.0 KB");
    uploadBinary.mockResolvedValue({ name: "IMG_0001.JPG" });
    await useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    expect(toast.mock.calls.map((c) => c[0])).toEqual([
      "IMG_0001.JPG uploaded (compressed 5.0 MB → 480.0 KB)",
    ]);
  });

  it("surfaces the server's error message", async () => {
    uploadBinary.mockRejectedValue(new FakeApiError(413, "too large"));
    await useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    expect(toast.mock.calls[0]).toEqual(["too large", "error"]);
  });

  it("falls back to a generic message for a non-ApiError failure", async () => {
    uploadBinary.mockRejectedValue(new Error("boom"));
    await useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    expect(toast.mock.calls[0]).toEqual(["upload failed", "error"]);
  });

  it("keeps going after a failed file so the rest of the batch lands", async () => {
    uploadBinary
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ name: "b" });
    await useUploads.getState().start({ sessionId: "s1", files: [file("a"), file("b")] });
    await settle();
    expect(uploadBinary).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls.map((c) => c[0])).toEqual(["upload failed", "b uploaded"]);
  });

  it("announces the retry the client runs on its own", async () => {
    // The retry lives inside uploadBinary, so the store sees one call that
    // reports the retry on its way to a result.
    uploadBinary.mockImplementationOnce((_target, _file, options) => {
      options.onRetry?.(2, "network error (sent 3.0 MB of 5.0 MB, connection dropped)");
      return Promise.resolve({ name: "b" });
    });
    await useUploads.getState().start({ sessionId: "s1", files: [file("a")] });
    await settle();
    expect(toast.mock.calls.map((c) => c[0])).toEqual([
      "retrying a — network error (sent 3.0 MB of 5.0 MB, connection dropped)",
      "b uploaded",
    ]);
  });
});

describe("onSettled", () => {
  it("runs once after the whole batch, either way", async () => {
    uploadBinary.mockResolvedValue({ name: "n" });
    const onSettled = vi.fn();
    await useUploads.getState().start({
      sessionId: "s1",
      files: [file("a"), file("b")],
      onSettled,
    });
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
