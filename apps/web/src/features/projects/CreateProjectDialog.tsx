import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Project } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { DirectoryPickerModal } from "../../components/DirectoryPickerModal";
import { Modal } from "../../components/Modal";
import { basenamePosix } from "../../util/dom";

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function applyRootPath(value: string) {
    setRootPath(value);
    if (!nameDirty) {
      const base = basenamePosix(value.trim().replace(/\/+$/, ""));
      if (base) setName(base);
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api.projects.create({ name, rootPath });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameDirty(true);
            }}
            placeholder="race-platform"
          />
        </label>
        <label>
          Root path
          <span className="path-row">
            <input
              value={rootPath}
              onChange={(event) => applyRootPath(event.target.value)}
              placeholder="/home/you/projects/race-platform"
            />
            <button type="button" onClick={() => setPickerOpen(true)}>
              Browse…
            </button>
          </span>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name || !rootPath}>
            Create
          </button>
        </div>
      </form>
      {pickerOpen && (
        <DirectoryPickerModal
          initialPath={rootPath || undefined}
          onSelect={(path) => applyRootPath(path)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Modal>
  );
}
