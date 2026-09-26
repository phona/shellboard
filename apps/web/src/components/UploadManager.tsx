import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useUi } from "../state/store";
import { useUploads } from "../state/uploads";
import { isTypingTarget } from "../util/dom";

function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0) files.push(...Array.from(data.files));
  return files;
}

/**
 * Workspace-level paste entry: pasting files or images anywhere outside a
 * typing target or the terminal uploads them into the selected session's
 * upload buffer. The terminal never sees its paste intercepted (.xterm is a
 * typing target), and no upload ever fires automatically — paste is the
 * user's gesture. Also renders the progress pill.
 */
export function UploadManager() {
  const selectedSessionId = useUi((state) => state.selectedSessionId);
  const tasks = useUploads((state) => state.tasks);
  const queryClient = useQueryClient();

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!selectedSessionId) return;
      if (isTypingTarget(event.target)) return;
      const files = filesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      useUploads.getState().start({
        sessionId: selectedSessionId,
        files,
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: ["uploads"] });
        },
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [selectedSessionId, queryClient]);

  const current = tasks[0];
  if (!current) return null;
  const rest = tasks.length - 1;
  return (
    <div className="upload-pill" role="status" aria-live="polite">
      <div className="upload-pill-track">
        <div className="upload-pill-bar" style={{ width: `${current.percent}%` }} />
      </div>
      <span>
        uploading {current.name} · {current.percent}%{rest > 0 ? ` (+${rest})` : ""}
      </span>
    </div>
  );
}
