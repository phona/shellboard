import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import { ApiError, api } from "../../api/client";

/**
 * Full-width diff of one file, shown in the main workspace while the agent
 * terminal stays mounted underneath (hidden, same size — tmux never reflows).
 * The right-panel Diff tab owns the file list; this owns the rendering.
 */
export function DiffView({
  sessionId,
  path,
  staged,
  letter,
  onClose,
}: {
  sessionId: string;
  path: string;
  staged: boolean;
  letter: string;
  onClose: () => void;
}) {
  const [split, setSplit] = useState(false);
  const diff = useQuery({
    queryKey: ["git", "diff", sessionId, path, staged],
    queryFn: () => api.git.diff(sessionId, { path, staged }),
  });

  const parsed = useMemo(() => (diff.data ? parseDiff(diff.data.text) : []), [diff.data]);
  const binaryNote = (diff.data?.text ?? "").includes("Binary files");

  return (
    <div className="panel-body diff-layout">
      <div className="panel-toolbar">
        <button
          type="button"
          className="btn primary"
          title="Back to the agent terminal (Esc)"
          onClick={onClose}
        >
          ‹ Back to terminal
        </button>
        <span className="diff-path" title={path}>
          {path}
        </span>
        <span style={{ flex: 1 }} />
        <label>
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          Split
        </label>
      </div>

      <div className="diff-area">
        {diff.isLoading && <div className="placeholder">loading…</div>}
        {diff.isError && (
          <div className="placeholder">
            {diff.error instanceof ApiError ? diff.error.message : "failed to load diff"}
          </div>
        )}
        {binaryNote && <div className="placeholder">Binary file — diff not shown</div>}
        {letter === "?" && !binaryNote && (
          <div className="placeholder">Untracked file — stage it to see the diff</div>
        )}
        {!diff.isLoading &&
          !diff.isError &&
          !binaryNote &&
          letter !== "?" &&
          parsed.length === 0 && <div className="placeholder">No diff</div>}
        {!diff.isLoading &&
          !diff.isError &&
          !binaryNote &&
          parsed.map((file) => (
            <div key={`${file.oldPath}-${file.newPath}`} className="diff-file">
              {/* the toolbar already names the file — no per-file head */}
              <div className="diff-view">
                <Diff viewType={split ? "split" : "unified"} diffType={file.type} hunks={file.hunks}>
                  {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                </Diff>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
