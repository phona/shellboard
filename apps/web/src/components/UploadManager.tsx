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
 * Workspace-level paste entry, two lanes:
 * - bubble lane: files/images pasted outside any typing target upload into
 *   the selected session's upload buffer;
 * - capture lane: when the terminal itself is focused, a clipboard holding
 *   files but no text is diverted to the buffer — xterm consumes text/plain
 *   only, so an image-only paste is a terminal no-op and this loses it
 *   nothing. Any text in the clipboard means the terminal keeps the paste.
 *
 * No upload ever fires automatically — paste is the user's gesture. Also
 * renders the progress pill.
 */
export function UploadManager() {
  const selectedSessionId = useUi((state) => state.selectedSessionId);
  const tasks = useUploads((state) => state.tasks);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!selectedSessionId) return;
    const start = (files: File[]) => {
      useUploads.getState().start({
        sessionId: selectedSessionId,
        files,
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: ["uploads"] });
        },
      });
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const files = filesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      start(files);
    };
    window.addEventListener("paste", onPaste);
    // xterm's own paste handler (xterm.js 6.0 handlePasteEvent) calls
    // stopPropagation() unconditionally, so a bubble listener never sees
    // terminal pastes; this capture listener is the only hook in front of it.
    const onPasteCapture = (event: ClipboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest(".xterm") === null) return;
      const data = event.clipboardData;
      if (!data || data.getData("text/plain") !== "") return;
      const files = filesFromClipboard(data);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      start(files);
    };
    window.addEventListener("paste", onPasteCapture, true);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("paste", onPasteCapture, true);
    };
  }, [selectedSessionId, queryClient]);

  const current = tasks[0];
  if (!current) return null;
  const rest = tasks.length - 1;
  return (
    <div className="upload-pill" role="status" aria-live="polite">
      <div className="upload-pill-track">
        <div className="upload-pill-bar" style={{ transform: `scaleX(${current.percent / 100})` }} />
      </div>
      <span>
        uploading {current.name} · {current.percent}%{rest > 0 ? ` (+${rest})` : ""}
      </span>
    </div>
  );
}
