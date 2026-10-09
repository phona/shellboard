import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FileEntry, SessionWithRuntime, UploadEntry } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { IconCopy } from "../../components/icons";
import { FileEditor } from "./FileEditor";
import { toast } from "../../state/toasts";
import { useUploads } from "../../state/uploads";
import { joinPosix, parentPosix, rowActivator } from "../../util/dom";
import { formatSize } from "../../util/format";

const ICONS: Record<FileEntry["type"], string> = {
  dir: "▸",
  file: "≡",
  symlink: "→",
  other: "·",
};

type PromptState =
  | { kind: "file" }
  | { kind: "dir" }
  | { kind: "rename"; entry: FileEntry };

export function FilesPanel({ data }: { data: SessionWithRuntime }) {
  const id = data.session.id;
  const queryClient = useQueryClient();
  const [dir, setDir] = useState(".");
  const [editing, setEditing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<FileEntry | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const laneInputRef = useRef<HTMLInputElement | null>(null);

  const list = useQuery({
    queryKey: ["files", "list", id, dir],
    queryFn: () => api.files.list(id, dir),
    retry: 0,
  });

  const uploads = useQuery({
    queryKey: ["uploads", id],
    queryFn: () => api.uploads.list(id),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["files", "list"] });
    await queryClient.invalidateQueries({ queryKey: ["git"] });
  };

  const invalidateUploads = () => {
    void queryClient.invalidateQueries({ queryKey: ["uploads"] });
  };

  const onError = (err: unknown, fallback: string) =>
    toast(err instanceof ApiError ? err.message : fallback, "error");

  const create = useMutation({
    mutationFn: (input: { path: string; type: "file" | "dir" }) =>
      api.files.create(id, { ...input, encoding: "utf8" }),
    onSuccess: () => {
      setPrompt(null);
      void invalidate();
    },
    onError: (err) => onError(err, "create failed"),
  });
  const rename = useMutation({
    mutationFn: (input: { path: string; newName: string }) =>
      api.files.rename(id, input.path, input.newName),
    onSuccess: () => {
      setPrompt(null);
      void invalidate();
    },
    onError: (err) => onError(err, "rename failed"),
  });
  const remove = useMutation({
    mutationFn: (entry: FileEntry) =>
      api.files.remove(id, entry.path, entry.type === "dir"),
    onSuccess: () => {
      setConfirmRemove(null);
      void invalidate();
    },
    onError: (err) => onError(err, "delete failed"),
  });
  const sendUpload = useMutation({
    mutationFn: (name: string) => api.uploads.send(id, name),
    onSuccess: () => toast("path sent to terminal"),
    onError: (err) => onError(err, "send failed"),
  });
  const removeUpload = useMutation({
    mutationFn: (name: string) => api.uploads.remove(id, name),
    onSuccess: invalidateUploads,
    onError: (err) => onError(err, "delete failed"),
  });

  const copyUploadPath = (entry: UploadEntry) => {
    void navigator.clipboard.writeText(entry.path).then(() => toast("path copied"));
  };

  // Explicit intent: the toolbar button uploads into the browsed directory.
  const uploadToDir = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    useUploads.getState().start({
      sessionId: id,
      files: Array.from(files),
      dir,
      onSettled: invalidate,
    });
  };

  // Quick-drop gestures (drag, paste, photo picker) go to the upload buffer —
  // the working tree is never touched without an explicit target.
  const uploadToBuffer = (files: File[]) => {
    if (files.length === 0) return;
    useUploads.getState().start({ sessionId: id, files, onSettled: invalidateUploads });
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    uploadToBuffer(Array.from(event.dataTransfer.files));
  };

  if (editing) {
    return (
      <FileEditor
        key={editing}
        sessionId={id}
        path={editing}
        onNavigatePath={setEditing}
        onBack={() => {
          setEditing(null);
          void invalidate();
        }}
      />
    );
  }

  const segments = dir === "." ? [] : dir.split("/");

  return (
    <div className="files-layout panel-body" style={{ flexDirection: "column" }}>
      <div className="panel-toolbar">
        <button
          type="button"
          className="icon-btn"
          title="Up"
          disabled={dir === "."}
          onClick={() => setDir(parentPosix(dir))}
        >
          ↑
        </button>
        <div className="breadcrumb">
          <button type="button" onClick={() => setDir(".")}>
            {data.session.name}
          </button>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`} style={{ display: "flex", gap: 2 }}>
              <span className="sep">/</span>
              <button
                type="button"
                onClick={() => setDir(segments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" title="New file" onClick={() => { setPrompt({ kind: "file" }); setPromptValue(""); }}>
          + File
        </button>
        <button type="button" title="New folder" onClick={() => { setPrompt({ kind: "dir" }); setPromptValue(""); }}>
          + Dir
        </button>
        <button type="button" title="Upload into this directory" onClick={() => uploadRef.current?.click()}>
          ↑ File
        </button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            uploadToDir(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div
        className={dragOver ? "file-tree dragover" : "file-tree"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="uploads-section">
          <div className="uploads-head">
            <span className="section-label">
              Uploads
              {(uploads.data?.entries.length ?? 0) > 0 && ` (${uploads.data?.entries.length})`}
            </span>
            <span className="spacer" />
            <input
              ref={laneInputRef}
              type="file"
              multiple
              accept="image/*"
              hidden
              onChange={(event) => {
                uploadToBuffer(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-btn"
              title="Upload image into the buffer (never the repo)"
              onClick={() => laneInputRef.current?.click()}
            >
              ↑ Img
            </button>
          </div>
          {(uploads.data?.entries ?? []).map((entry) => (
            <div key={entry.name} className="tree-row upload-row" title={entry.path}>
              <span className="icon" style={{ color: "var(--accent)" }}>
                ↑
              </span>
              <span className="name">{entry.name}</span>
              <span className="size">{formatSize(entry.size)}</span>
              <span className="row-actions">
                <button
                  type="button"
                  title="Send absolute path to the agent shell (types it, no Enter)"
                  onClick={() => sendUpload.mutate(entry.name)}
                >
                  →
                </button>
                <button
                  type="button"
                  title="Copy absolute path"
                  onClick={() => copyUploadPath(entry)}
                >
                  <IconCopy />
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => removeUpload.mutate(entry.name)}
                >
                  ×
                </button>
              </span>
            </div>
          ))}
        </div>
        {list.isLoading && <div className="tool-placeholder">loading…</div>}
        {list.isError && (
          <div className="tool-placeholder">
            {list.error instanceof ApiError ? list.error.message : "cannot list directory"}
          </div>
        )}
        {(list.data?.entries ?? []).map((entry) => (
          <div
            key={entry.name}
            className="tree-row"
            onClick={() => {
              if (entry.type === "dir") setDir(entry.path);
              else if (entry.type === "file") setEditing(entry.path);
              else if (entry.type === "symlink") toast("symlink — not opened");
            }}
            {...rowActivator(() => {
              if (entry.type === "dir") setDir(entry.path);
              else if (entry.type === "file") setEditing(entry.path);
              else if (entry.type === "symlink") toast("symlink — not opened");
            })}
          >
            <span className="icon" style={{ color: entry.type === "dir" ? "var(--accent)" : "var(--text-muted)" }}>
              {ICONS[entry.type]}
            </span>
            <span>{entry.name}</span>
            <span className="size">{entry.type === "dir" ? "" : formatSize(entry.size)}</span>
            <span className="row-actions">
              {entry.type !== "dir" && (
                <a
                  href={api.files.downloadUrl(id, entry.path)}
                  title="Download"
                  onClick={(event) => event.stopPropagation()}
                >
                  ↓
                </a>
              )}
              <button
                type="button"
                title="Rename"
                onClick={(event) => {
                  event.stopPropagation();
                  setPrompt({ kind: "rename", entry });
                  setPromptValue(entry.name);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                title="Delete"
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirmRemove(entry);
                }}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        {list.isSuccess && (list.data?.entries.length ?? 0) === 0 && (
          <div className="tool-placeholder">empty directory</div>
        )}
      </div>

      {prompt && (
        <Modal
          title={
            prompt.kind === "file"
              ? "New file"
              : prompt.kind === "dir"
                ? "New folder"
                : `Rename ${prompt.entry.name}`
          }
          onClose={() => setPrompt(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!promptValue) return;
              if (prompt.kind === "file") {
                create.mutate({ path: joinPosix(dir, promptValue), type: "file" });
              } else if (prompt.kind === "dir") {
                create.mutate({ path: joinPosix(dir, promptValue), type: "dir" });
              } else {
                rename.mutate({ path: prompt.entry.path, newName: promptValue });
              }
            }}
          >
            <label>
              Name
              <input
                autoFocus
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setPrompt(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                {prompt.kind === "rename" ? "Rename" : "Create"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirmRemove && (
        <Modal title="Delete" onClose={() => setConfirmRemove(null)}>
          <div>
            Delete <strong>{confirmRemove.name}</strong>
            {confirmRemove.type === "dir" ? " and everything inside it" : ""}? This cannot be
            undone.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmRemove(null)}>
              Cancel
            </button>
            {/* Disabled while in flight: a double-click would fire the
                destructive request twice and surface a confusing failure
                for the second one. */}
            <button
              type="button"
              className="btn danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(confirmRemove)}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
