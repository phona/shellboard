import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import { rowActivator } from "../util/dom";
import { Modal } from "./Modal";

/**
 * Server-side directory picker: browsers cannot see the server filesystem,
 * so we browse it through the read-only /api/fs/directories endpoint.
 */
export function DirectoryPickerModal({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | undefined>(initialPath || undefined);
  const [jump, setJump] = useState("");
  const listing = useQuery({
    queryKey: ["fs", "dirs", path ?? null],
    queryFn: () => api.fs.directories(path),
    retry: 0,
  });

  useEffect(() => {
    if (listing.data && jump.length === 0) setJump(listing.data.path);
  }, [listing.data, jump.length]);

  const entries = listing.data?.entries ?? [];
  const parent = listing.data?.parent ?? null;
  const current = listing.data?.path;

  return (
    <Modal title="Choose directory" onClose={onClose}>
      <div className="dir-current" title={current}>
        {current ?? "loading…"}
      </div>
      <div className="dir-list">
        {listing.isLoading && <div className="tool-placeholder">loading…</div>}
        {listing.isError && (
          <div className="tool-placeholder">
            {listing.error instanceof ApiError ? listing.error.message : "cannot list directory"}
          </div>
        )}
        {parent && (
          <div className="tree-row" onClick={() => setPath(parent)} {...rowActivator(() => setPath(parent))}>
            <span className="icon">↑</span>
            <span>..</span>
          </div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="tree-row"
            onClick={() => setPath(entry.path)}
            {...rowActivator(() => setPath(entry.path))}
          >
            <span className="icon" style={{ color: "var(--accent)" }}>
              ▸
            </span>
            <span>{entry.name}</span>
          </div>
        ))}
        {listing.isSuccess && entries.length === 0 && !parent && (
          <div className="tool-placeholder">no subdirectories</div>
        )}
        {listing.isSuccess && entries.length === 0 && parent && (
          <div className="tool-placeholder">empty directory</div>
        )}
      </div>
      <form
        className="dir-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (jump.trim()) setPath(jump.trim());
        }}
      >
        <input
          value={jump}
          onChange={(event) => setJump(event.target.value)}
          placeholder="/absolute/path/to/dir"
        />
        <button type="submit">Go</button>
      </form>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!current}
          onClick={() => {
            if (current) onSelect(current);
            onClose();
          }}
        >
          Select this directory
        </button>
      </div>
    </Modal>
  );
}
