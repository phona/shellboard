import { create } from "zustand";
import { ApiError, api, uploadBinary } from "../api/client.js";
import { prepareUpload, resizeSummary } from "../util/imageUpload.js";
import { toast } from "./toasts.js";

export interface StartUploads {
  sessionId: string;
  files: File[];
  /** Repo-relative directory inside the session cwd; omitted = upload buffer. */
  dir?: string;
  /** Called once after the whole batch finishes (either way). */
  onSettled?: () => void;
}

export interface UploadTask {
  id: number;
  name: string;
  percent: number;
  /** "compressing" is the re-encode before the first byte leaves the device. */
  phase: "compressing" | "uploading";
}

interface UploadsState {
  tasks: UploadTask[];
  start(input: StartUploads): void;
}

let nextTaskId = 1;

/**
 * Global upload queue: one file at a time, one progress pill, per-file toast.
 * Buffer-lane uploads get an action that types a path into the agent shell —
 * the entry that landed, or, when the file was re-encoded first, the untouched
 * original. Repo-dir uploads are plain. The store owns neither queries nor
 * navigation — callers pass onSettled to invalidate what they display.
 */
export const useUploads = create<UploadsState>()((set) => {
  const patch = (id: number, fields: Partial<UploadTask>) =>
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...fields } : task)),
    }));
  const drop = (id: number) =>
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));

  /** Types a buffer path into the agent pane (D6: literal, no Enter). */
  const sendBufferPath = async (sessionId: string, name: string) => {
    try {
      await api.uploads.send(sessionId, name);
      toast("path sent to terminal");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "send failed", "error");
    }
  };

  return {
    tasks: [],
    start: (input) => {
      void (async () => {
        for (const file of input.files) {
          const id = nextTaskId++;
          set((state) => ({
            tasks: [...state.tasks, { id, name: file.name, percent: 0, phase: "compressing" }],
          }));
          try {
            // A big phone photo is re-encoded here, before any bytes move:
            // the transfer a phone can actually finish is a fraction of the
            // size of what its camera produces.
            const prepared = await prepareUpload(file);
            patch(id, { phase: "uploading" });
            const { name } = await uploadBinary(
              { sessionId: input.sessionId, dir: input.dir },
              prepared.file,
              {
                onProgress: (percent) => patch(id, { percent }),
                onRetry: (_attempt, reason) => toast(`retrying ${file.name} — ${reason}`),
              },
            );
            const summary = resizeSummary(prepared);
            const message =
              summary === null
                ? `${name} uploaded`
                : `${name} uploaded (compressed ${summary})`;
            if (input.dir === undefined) {
              // A re-encoded photo is not what the camera produced, so the
              // escape hatch rides on this toast: it pushes the untouched
              // original into the buffer and types *that* path. Sending the
              // shrunken copy stays available per entry in the buffer list.
              const resized = prepared.resizedFrom !== null;
              toast(message, "info", {
                label: resized ? "send original" : "Send",
                onClick: () => {
                  if (!resized) {
                    void sendBufferPath(input.sessionId, name);
                    return;
                  }
                  void (async () => {
                    try {
                      const { name: originalName } = await uploadBinary(
                        { sessionId: input.sessionId },
                        file,
                      );
                      await sendBufferPath(input.sessionId, originalName);
                    } catch (err) {
                      toast(
                        err instanceof ApiError ? err.message : "send original failed",
                        "error",
                      );
                    }
                  })();
                },
              });
            } else {
              toast(message);
            }
          } catch (err) {
            toast(err instanceof ApiError ? err.message : "upload failed", "error");
          } finally {
            drop(id);
          }
        }
        input.onSettled?.();
      })();
    },
  };
});
