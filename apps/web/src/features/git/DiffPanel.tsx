import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import type { SessionWithRuntime } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { toast } from "../../state/toasts";
import { basenamePosix, dirnamePosix } from "../../util/dom";

interface FileRow {
  path: string;
  origPath: string | null;
  letter: string;
  staged: boolean;
}

function letterOf(x: string, y: string): string {
  if (x === "?") return "?";
  if (x !== " ") return x;
  if (y !== " ") return y;
  return "M";
}

function FileRow({
  row,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: FileRow;
  selected: boolean;
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={selected ? "file-row selected" : "file-row"}
      onClick={onSelect}
      title={row.origPath ? `${row.origPath} → ${row.path}` : row.path}
    >
      <span className={`letter letter-${row.letter}`}>{row.letter}</span>
      <span className="path">
        <span className="dir">{dirnamePosix(row.path)}</span>
        {dirnamePosix(row.path) && "/"}
        <strong>{basenamePosix(row.path)}</strong>
      </span>
      <span className="row-actions">
        {row.staged ? (
          <button
            type="button"
            title="Unstage"
            onClick={(event) => {
              event.stopPropagation();
              onUnstage();
            }}
          >
            −
          </button>
        ) : (
          <button
            type="button"
            title="Stage"
            onClick={(event) => {
              event.stopPropagation();
              onStage();
            }}
          >
            +
          </button>
        )}
        <button
          type="button"
          title="Discard"
          onClick={(event) => {
            event.stopPropagation();
            onDiscard();
          }}
        >
          ↺
        </button>
      </span>
    </div>
  );
}

export function DiffPanel({ data }: { data: SessionWithRuntime }) {
  const id = data.session.id;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [split, setSplit] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["git", "status", id],
    queryFn: () => api.git.status(id),
    refetchInterval: 5000,
  });

  const diff = useQuery({
    queryKey: ["git", "diff", id, selected?.path, selected?.staged, split],
    queryFn: () => api.git.diff(id, { path: selected?.path, staged: selected?.staged }),
    enabled: selected !== null,
  });

  const files = useMemo<FileRow[]>(
    () =>
      (status.data?.entries ?? []).map((entry) => ({
        path: entry.path,
        origPath: entry.origPath,
        letter: letterOf(entry.x, entry.y),
        staged: entry.x !== " " && entry.x !== "?",
      })),
    [status.data],
  );
  const stagedFiles = files.filter((row) => row.staged);
  const unstagedFiles = files.filter((row) => !row.staged);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["git"] });
  const stage = useMutation({
    mutationFn: (path: string) => api.git.stage(id, path),
    onSuccess: invalidate,
    onError: (err) => toast(err instanceof ApiError ? err.message : "stage failed", "error"),
  });
  const unstage = useMutation({
    mutationFn: (path: string) => api.git.unstage(id, path),
    onSuccess: invalidate,
    onError: (err) => toast(err instanceof ApiError ? err.message : "unstage failed", "error"),
  });
  const discard = useMutation({
    mutationFn: (path: string) => api.git.discard(id, path),
    onSuccess: () => {
      setConfirmDiscard(null);
      invalidate();
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "discard failed", "error"),
  });

  const parsed = useMemo(() => (diff.data ? parseDiff(diff.data.text) : []), [diff.data]);
  const binaryNote = (diff.data?.text ?? "").includes("Binary files");
  const selectedRow = files.find(
    (row) => selected !== null && row.path === selected.path,
  );

  const renderRows = (rows: FileRow[], stagedView: boolean) =>
    rows.map((row) => (
      <FileRow
        key={row.path}
        row={row}
        selected={
          selected?.path === row.path && selected?.staged === stagedView
        }
        onSelect={() => setSelected({ path: row.path, staged: stagedView })}
        onStage={() => stage.mutate(row.path)}
        onUnstage={() => unstage.mutate(row.path)}
        onDiscard={() => setConfirmDiscard(row.path)}
      />
    ));

  return (
    <div className="diff-layout panel-body" style={{ flexDirection: "column" }}>
      <div className="panel-toolbar">
        <span className="branch">{status.data?.branch ?? "no git"}</span>
        <span className="count">{files.length} changed</span>
        <label>
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          split
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void status.refetch()}>
          refresh
        </button>
      </div>

      <div className="file-list">
        {stagedFiles.length > 0 && <div className="section-label">STAGED</div>}
        {renderRows(stagedFiles, true)}
        {stagedFiles.length > 0 && unstagedFiles.length > 0 && (
          <div className="section-label">CHANGES</div>
        )}
        {stagedFiles.length === 0 && <div className="section-label">CHANGES</div>}
        {renderRows(unstagedFiles, false)}
        {files.length === 0 && <div className="sidebar-empty">No changes</div>}
      </div>

      <div className="diff-area">
        {!selected && <div className="placeholder">Select a file to view its diff</div>}
        {selected && diff.isLoading && <div className="placeholder">loading…</div>}
        {selected && binaryNote && (
          <div className="placeholder">Binary file — diff not shown</div>
        )}
        {selected && selectedRow?.letter === "?" && !binaryNote && (
          <div className="placeholder">Untracked file — stage it to see the diff</div>
        )}
        {selected &&
          !diff.isLoading &&
          !binaryNote &&
          parsed.map((file) => (
            <div key={`${file.oldPath}-${file.newPath}`} className="diff-file">
              <div className="diff-file-head">{file.newPath || file.oldPath}</div>
              <div className="diff-view">
                <Diff viewType={split ? "split" : "unified"} diffType={file.type} hunks={file.hunks}>
                  {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                </Diff>
              </div>
            </div>
          ))}
      </div>

      {confirmDiscard && (
        <Modal title="Discard changes" onClose={() => setConfirmDiscard(null)}>
          <div>
            Discard all changes in <strong>{confirmDiscard}</strong>? This cannot be undone.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => discard.mutate(confirmDiscard)}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
