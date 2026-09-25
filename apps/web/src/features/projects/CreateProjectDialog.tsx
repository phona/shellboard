import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Project } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
            onChange={(event) => setName(event.target.value)}
            placeholder="race-platform"
          />
        </label>
        <label>
          Root path
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="/home/you/projects/race-platform"
          />
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
    </Modal>
  );
}
