import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AGENT_PRESETS } from "@shellboard/contracts";
import type { AgentType, Project } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { useUi } from "../../state/store";

export function CreateSessionDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.sessions.create({
        projectId: project.id,
        name: name || `${project.name}-session`,
        cwd: cwd || undefined,
        agentType,
        command: agentType === "custom" ? command : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      useUi.getState().selectSession(created.session.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New session · ${project.name}`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="preset-grid">
          {AGENT_PRESETS.map((preset) => (
            <div
              key={preset.id}
              className={preset.id === agentType ? "preset selected" : "preset"}
              onClick={() => setAgentType(preset.id)}
            >
              {preset.label}
            </div>
          ))}
        </div>
        <label>
          Name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={`${project.name}-1`}
          />
        </label>
        <label>
          Working directory
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder={project.rootPath}
          />
        </label>
        {agentType === "custom" && (
          <label>
            Command
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="aider --model …"
            />
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || (agentType === "custom" && !command)}
          >
            Start session
          </button>
        </div>
      </form>
    </Modal>
  );
}
