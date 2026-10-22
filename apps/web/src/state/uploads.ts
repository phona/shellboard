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

/** A buffer path held for confirmation. Nothing is typed into the pane until the
    user confirms, the same gate the terminal puts in front of a multi-line
    paste — see components/SendConfirm.tsx. */
export interface PendingSend {
  sessionId: string;
  /** Server-side name in the upload buffer. */
  name: string;
  /** Absolute path the server will type — what the dialog shows. */
  path: string;
  /** Bytes, when the caller knows them. */
  size: number | null;
}

interface UploadsState {
  tasks: UploadTask[];
  pending: PendingSend | null;
  start(input: StartUploads): void;
  requestSend(send: PendingSend): void;
  cancelSend(): void;
  confirmSend(): void;
}

let nextTaskId = 1;

/**
 * Global upload queue: one file at a time, one progress pill, per-file toast.
 * Buffer-lane uploads get an action that asks before typing a path into the
 * agent shell — the entry that landed, or, when the file was re-encoded first,
 * the untouched original. Repo-dir uploads are plain. The store owns neither
 * queries nor navigation — callers pass onSettled to invalidate what they
 * display.
 */
export const useUploads = create<UploadsState>()((set, get) => {
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

  /** Holds a buffer entry for the send confirmation. The lane answers with the
      absolute path the send will type, so a response without one is a contract
      break — and a dialog whose whole job is showing the exact payload must not
      offer to send something it cannot show. */
  const holdForConfirmation = (
    sessionId: string,
    entry: { name: string; path: string | null },
    size: number,
  ): void => {
    if (entry.path === null) {
      toast("upload answered without a path — nothing sent", "error");
      return;
    }
    set({ pending: { sessionId, name: entry.name, path: entry.path, size } });
  };

  return {
    tasks: [],
    pending: null,
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
            const entry = await uploadBinary(
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
                ? `${entry.name} uploaded`
                : `${entry.name} uploaded (compressed ${summary})`;
            if (input.dir === undefined) {
              // A re-encoded photo is not what the camera produced, so the
              // escape hatch rides on this toast: it pushes the untouched
              // original into the buffer and confirms *that* path. Sending the
              // shrunken copy stays available per entry in the buffer list.
              const resized = prepared.resizedFrom !== null;
              toast(message, "info", {
                label: resized ? "Send original" : "Send",
                onClick: () => {
                  if (!resized) {
                    holdForConfirmation(input.sessionId, entry, prepared.file.size);
                    return;
                  }
                  void (async () => {
                    try {
                      // The dialog opens only once the original has landed: it
                      // must show the path that will actually be typed.
                      const original = await uploadBinary(
                        { sessionId: input.sessionId },
                        file,
                      );
                      holdForConfirmation(input.sessionId, original, file.size);
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
    requestSend: (send) => set({ pending: send }),
    cancelSend: () => set({ pending: null }),
    confirmSend: () => {
      const send = get().pending;
      if (!send) return;
      // Clear first: the dialog closes on the click, and a second Enter must
      // not find a payload to send twice.
      set({ pending: null });
      void sendBufferPath(send.sessionId, send.name);
    },
  };
});
