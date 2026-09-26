import { create } from "zustand";
import { ApiError, api, uploadBinary } from "../api/client.js";
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
}

interface UploadsState {
  tasks: UploadTask[];
  start(input: StartUploads): void;
}

let nextTaskId = 1;

/**
 * Global upload queue: one file at a time, one progress pill, per-file toast.
 * Buffer-lane uploads offer "Send" (types the absolute path into the agent
 * shell); repo-dir uploads are plain. The store owns neither queries nor
 * navigation — callers pass onSettled to invalidate what they display.
 */
export const useUploads = create<UploadsState>()((set) => {
  const patch = (id: number, fields: Partial<UploadTask>) =>
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...fields } : task)),
    }));
  const drop = (id: number) =>
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));

  return {
    tasks: [],
    start: (input) => {
      void (async () => {
        for (const file of input.files) {
          const id = nextTaskId++;
          set((state) => ({ tasks: [...state.tasks, { id, name: file.name, percent: 0 }] }));
          try {
            const { name } = await uploadBinary(
              { sessionId: input.sessionId, dir: input.dir },
              file,
              (percent) => patch(id, { percent }),
            );
            if (input.dir === undefined) {
              toast(`${name} uploaded`, "info", {
                label: "Send",
                onClick: () => {
                  api.uploads
                    .send(input.sessionId, name)
                    .then(() => toast("path sent to terminal"))
                    .catch((err: unknown) =>
                      toast(err instanceof ApiError ? err.message : "send failed", "error"),
                    );
                },
              });
            } else {
              toast(`${name} uploaded`);
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
