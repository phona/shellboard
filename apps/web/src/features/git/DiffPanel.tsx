import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { SessionWithRuntime } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { useUi } from "../../state/store";
import { toast } from "../../state/toasts";
import { basenamePosix, dirnamePosix, rowActivator } from "../../util/dom";

interface FileRow {
  path: string;
  origPath: string | null;
  letter: string;
  staged: boolean;
}

// git status --porcelain=v2 marks "unmodified" with "." (v1 used a space):
// x is the index status (staged), y the worktree status (unstaged)
function letterOf(x: string, y: string): string {
  if (x === "?") return "?";
  if (x !== "." && x !== " ") return x;
  if (y !== "." && y !== " ") return y;
  return "M";
}

function RowActions({
  row,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: FileRow;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      {row.staged ? (
        <button type="button" title="Unstage" onClick={onUnstage}>
          −
        </button>
      ) : (
        <button type="button" title="Stage" onClick={onStage}>
          +
        </button>
      )}
      <button type="button" title="Discard" onClick={onDiscard}>
        ↺
      </button>
    </span>
  );
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
      {...rowActivator(onSelect)}
      title={row.origPath ? `${row.origPath} → ${row.path}` : row.path}
    >
      <span className={`letter letter-${row.letter}`}>{row.letter}</span>
      <span className="path">
        <span className="dir">{dirnamePosix(row.path)}</span>
        {dirnamePosix(row.path) && "/"}
        <strong>{basenamePosix(row.path)}</strong>
      </span>
      <RowActions row={row} onStage={onStage} onUnstage={onUnstage} onDiscard={onDiscard} />
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  row?: FileRow;
}

interface TreeEntry {
  kind: "dir" | "file";
  name: string;
  path: string;
  depth: number;
  row?: FileRow;
}

function buildTree(rows: FileRow[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const row of rows) {
    // untracked directories arrive as "dir/" — drop the trailing slash
    const segments = row.path.replace(/\/$/, "").split("/");
    let node = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, path, children: new Map(), row: isFile ? row : undefined };
        node.children.set(segment, child);
      }
      node = child;
    });
  }
  return root;
}

function treeEntries(rows: FileRow[], collapsed: Set<string>): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const entries = [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0 ? 0 : 1;
      const bDir = b.children.size > 0 ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (entry.children.size > 0) {
        out.push({ kind: "dir", name: entry.name, path: entry.path, depth });
        if (!collapsed.has(entry.path)) walk(entry, depth + 1);
      } else {
        out.push({ kind: "file", name: entry.name, path: entry.path, depth, row: entry.row });
      }
    }
  };
  walk(buildTree(rows), 0);
  return out;
}

export function DiffPanel({ data }: { data: SessionWithRuntime }) {
  const id = data.session.id;
  const queryClient = useQueryClient();
  const [treeMode, setTreeMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const openDiff = useUi((state) => state.openDiff);

  const status = useQuery({
    queryKey: ["git", "status", id],
    queryFn: () => api.git.status(id),
    refetchInterval: 5000,
  });

  const files = useMemo<FileRow[]>(
    () =>
      (status.data?.entries ?? []).map((entry) => ({
        path: entry.path,
        origPath: entry.origPath,
        letter: letterOf(entry.x, entry.y),
        staged: entry.x !== "." && entry.x !== " " && entry.x !== "?",
      })),
    [status.data],
  );
  const stagedFiles = files.filter((row) => row.staged);
  const unstagedFiles = files.filter((row) => !row.staged);
  const tree = useMemo(() => treeEntries(files, collapsed), [files, collapsed]);

  // keep the center DiffView in sync with the list: staging flips the row's
  // staged/letter state, discarding removes the file entirely (closes it)
  useEffect(() => {
    const current = useUi.getState().openDiff;
    if (!current) return;
    const matches = files.filter((row) => row.path === current.path);
    if (matches.length === 0) {
      useUi.getState().setOpenDiff(null);
      return;
    }
    const row = matches.find((candidate) => candidate.staged === current.staged) ?? matches[0];
    if (!row) return;
    if (row.staged !== current.staged || row.letter !== current.letter) {
      useUi.getState().setOpenDiff({ path: row.path, staged: row.staged, letter: row.letter });
    }
  }, [files]);

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

  const open = (row: FileRow) =>
    useUi.getState().setOpenDiff({ path: row.path, staged: row.staged, letter: row.letter });
  const isOpen = (row: FileRow) =>
    openDiff !== null && openDiff.path === row.path && openDiff.staged === row.staged;
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderFlat = () => (
    <>
      {stagedFiles.length > 0 && <div className="section-label">STAGED</div>}
      {stagedFiles.map((row) => (
        <FileRow
          key={`s:${row.path}`}
          row={row}
          selected={isOpen(row)}
          onSelect={() => open(row)}
          onStage={() => stage.mutate(row.path)}
          onUnstage={() => unstage.mutate(row.path)}
          onDiscard={() => setConfirmDiscard(row.path)}
        />
      ))}
      {(stagedFiles.length > 0 || unstagedFiles.length > 0) && (
        <div className="section-label">CHANGES</div>
      )}
      {unstagedFiles.map((row) => (
        <FileRow
          key={`u:${row.path}`}
          row={row}
          selected={isOpen(row)}
          onSelect={() => open(row)}
          onStage={() => stage.mutate(row.path)}
          onUnstage={() => unstage.mutate(row.path)}
          onDiscard={() => setConfirmDiscard(row.path)}
        />
      ))}
      {files.length === 0 && <div className="sidebar-empty">No changes</div>}
    </>
  );

  const renderTree = () =>
    tree.length === 0 ? (
      <div className="sidebar-empty">No changes</div>
    ) : (
      tree.map((entry) => {
        if (entry.kind === "dir") {
          return (
            <div
              key={`d:${entry.path}`}
              className="tree-row"
              style={{ paddingLeft: 10 + entry.depth * 12 }}
              title={entry.path}
              onClick={() => toggleDir(entry.path)}
              {...rowActivator(() => toggleDir(entry.path))}
            >
              <span className="chev">{collapsed.has(entry.path) ? "▸" : "▾"}</span>
              <span className="name">{entry.name}</span>
            </div>
          );
        }
        const row = entry.row;
        if (!row) return null;
        return (
          <div
            key={`f:${row.staged ? "s" : "u"}:${row.path}`}
            className={isOpen(row) ? "tree-row selected" : "tree-row"}
            style={{ paddingLeft: 10 + entry.depth * 12 }}
            title={row.origPath ? `${row.origPath} → ${row.path}` : row.path}
            onClick={() => open(row)}
            {...rowActivator(() => open(row))}
          >
            <span className={`letter letter-${row.letter}`}>{row.letter}</span>
            <span className="name">{entry.name}</span>
            <RowActions
              row={row}
              onStage={() => stage.mutate(row.path)}
              onUnstage={() => unstage.mutate(row.path)}
              onDiscard={() => setConfirmDiscard(row.path)}
            />
          </div>
        );
      })
    );

  return (
    <div className="diff-layout panel-body" style={{ flexDirection: "column" }}>
      <div className="panel-toolbar">
        <span className="branch">{status.data?.branch ?? "no git"}</span>
        <span className="count">{files.length} changed</span>
        <label>
          <input type="checkbox" checked={treeMode} onChange={(e) => setTreeMode(e.target.checked)} />
          Tree
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void status.refetch()}>
          Refresh
        </button>
      </div>

      <div className="file-list">{treeMode ? renderTree() : renderFlat()}</div>

      {confirmDiscard && (
        <Modal title="Discard changes" onClose={() => setConfirmDiscard(null)}>
          <div>
            Discard all changes in <strong>{confirmDiscard}</strong>? This cannot be undone.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </button>
            {/* Disabled while in flight: a double-click would fire the
                destructive request twice and surface a confusing failure
                for the second one. */}
            <button
              type="button"
              className="btn danger"
              disabled={discard.isPending}
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
