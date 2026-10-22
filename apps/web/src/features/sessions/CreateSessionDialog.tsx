import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AGENT_PRESETS } from "@shellboard/contracts";
import type { AgentType, Project } from "@shellboard/contracts";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { EnvEditor } from "../../components/EnvEditor";
import { useCommands } from "../../state/useCommands";
import { pairsToRecord, recordToPairs, type EnvPair } from "../../state/env";
import { useUi } from "../../state/store";
import { codename } from "../../util/codename";

export function CreateSessionDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: api.sessions.list });
  const commandsQuery = useCommands();
  const registeredCommands = commandsQuery.data ?? [];
  const [name, setName] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  /** Launch environment (D9): set by picking a registered command, editable
      for any agent type — "Claude Code with ANTHROPIC_MODEL=sonnet" does not
      need a preset. */
  const [env, setEnv] = useState<EnvPair[]>([]);
  /** The env editor reports its own validity: a bulk line that is not an
      assignment cannot round-trip through pairs, so launching stays off until
      the text parses. */
  const [envValid, setEnvValid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Auto-naming: an empty name becomes a codename (adjective-noun) that is
   * not taken within the project. Stable while the dialog is open — it only
   * recomputes when the session list changes.
   */
  const generated = useMemo(() => {
    const taken = new Set(
      (sessionsQuery.data?.sessions ?? [])
        .filter((item) => item.session.projectId === project.id)
        .map((item) => item.session.name),
    );
    return codename(taken);
  }, [sessionsQuery.data, project.id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.sessions.create({
        projectId: project.id,
        name: name.trim() || generated,
        cwd: cwd || undefined,
        agentType,
        command: agentType === "custom" ? command : undefined,
        env: pairsToRecord(env),
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
        {registeredCommands.length > 0 && (
          <>
            <div className="dialog-section">Your commands</div>
            <div className="preset-grid">
              {registeredCommands.map((item) => (
                <div
                  key={item.id}
                  className={
                    agentType === "custom" && command === item.command
                      ? "preset selected"
                      : "preset"
                  }
                  title={envTitle(item)}
                  onClick={() => {
                    setAgentType("custom");
                    setCommand(item.command);
                    setEnv(recordToPairs(item.env));
                  }}
                >
                  {item.name}
                </div>
              ))}
            </div>
          </>
        )}
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={generated}
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
        <details className="dialog-env">
          <summary>Environment</summary>
          <EnvEditor
            pairs={env}
            onChange={setEnv}
            onValidityChange={setEnvValid}
            namePrefix="session-env"
          />
        </details>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || (agentType === "custom" && !command) || !envValid}
          >
            Start session
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Hover text for a registered-command preset: the launch line plus, when the
    preset carries one, its environment. */
function envTitle(item: { command: string; env: Record<string, string> }): string {
  const summary = Object.keys(item.env)
    .sort()
    .map((key) => `${key}=${item.env[key]}`)
    .join(", ");
  return summary.length > 0 ? `${item.command}\n${summary}` : item.command;
}
