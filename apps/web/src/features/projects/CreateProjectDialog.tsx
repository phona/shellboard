import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ApiError,
  api,
  type ProjectAuth,
  type ProjectLocation,
  type ShellboardProject,
} from "../../api/client";
import { DirectoryPickerModal } from "../../components/DirectoryPickerModal";
import { Modal } from "../../components/Modal";
import { basenamePosix } from "../../util/dom";

function basenameProjectPath(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "";
  return basenamePosix(normalized.replaceAll("\\", "/"));
}

export function CreateProjectDialog({
  onClose,
  onCreated,
  project,
  onUpdated,
}: {
  onClose: () => void;
  onCreated?: (project: ShellboardProject) => void;
  project?: ShellboardProject;
  onUpdated?: (project: ShellboardProject) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  const [nameDirty, setNameDirty] = useState(project !== undefined);
  const [locationKind, setLocationKind] = useState<ProjectLocation["kind"]>(
    project?.location?.kind ?? "local",
  );
  const [host, setHost] = useState(
    project?.location?.kind === "ssh" ? project.location.host : "",
  );
  const [port, setPort] = useState(
    project?.location?.kind === "ssh" ? String(project.location.port) : "22",
  );
  const [username, setUsername] = useState(
    project?.location?.kind === "ssh" ? project.location.username : "",
  );
  const [authKind, setAuthKind] = useState<ProjectAuth["kind"]>(
    project?.location?.kind === "ssh" ? project.location.auth.kind : "key",
  );
  const [identityFile, setIdentityFile] = useState(
    project?.location?.kind === "ssh" && project.location.auth.kind === "key"
      ? project.location.auth.identityFile ?? ""
      : "",
  );
  const [rootPath, setRootPath] = useState(project?.rootPath ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function applyRootPath(value: string) {
    setRootPath(value);
    if (!nameDirty) {
      const base = basenameProjectPath(value);
      if (base) setName(base);
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const location: ProjectLocation =
        locationKind === "ssh"
          ? {
              kind: "ssh",
              host: host.trim(),
              port: Number(port),
              username: username.trim(),
              auth:
                authKind === "key"
                  ? { kind: "key", ...(identityFile.trim() && { identityFile: identityFile.trim() }) }
                  : { kind: "password-prompt" },
            }
          : { kind: "local" };
      const saved = project
        ? await api.projects.update(project.id, {
            name: name.trim(),
            rootPath: rootPath.trim(),
            location,
          })
        : await api.projects.create({
            name: name.trim(),
            rootPath: rootPath.trim(),
            location,
          });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      if (project) onUpdated?.(saved);
      else onCreated?.(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={project ? "Edit project" : "New project"} onClose={onClose}>
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
        <fieldset className="location-fieldset">
          <legend>Location</legend>
          <div className="location-toggle">
            <label className={locationKind === "local" ? "selected" : ""}>
              <input
                type="radio"
                name="project-location"
                value="local"
                checked={locationKind === "local"}
                onChange={() => setLocationKind("local")}
              />
              <span>
                Local
              </span>
            </label>
            <label className={locationKind === "ssh" ? "selected" : ""}>
              <input
                type="radio"
                name="project-location"
                value="ssh"
                checked={locationKind === "ssh"}
                onChange={() => setLocationKind("ssh")}
              />
              <span>
                SSH remote
              </span>
            </label>
          </div>
        </fieldset>
        {locationKind === "ssh" && (
          <label>
            Host or IP
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="dev.example.com or 192.168.1.20"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        {locationKind === "ssh" && (
          <div className="form-grid-2">
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                inputMode="numeric"
              />
            </label>
            <label>
              Username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="alice"
                autoComplete="username"
              />
            </label>
          </div>
        )}
        {locationKind === "ssh" && (
          <fieldset className="location-fieldset">
            <legend>Authentication</legend>
            <div className="location-toggle">
              <label className={authKind === "key" ? "selected" : ""}>
                <input
                  type="radio"
                  name="project-auth"
                  value="key"
                  checked={authKind === "key"}
                  onChange={() => setAuthKind("key")}
                />
                <span>SSH key / agent</span>
              </label>
              <label className={authKind === "password-prompt" ? "selected" : ""}>
                <input
                  type="radio"
                  name="project-auth"
                  value="password-prompt"
                  checked={authKind === "password-prompt"}
                  onChange={() => setAuthKind("password-prompt")}
                />
                <span>Password prompt</span>
              </label>
            </div>
          </fieldset>
        )}
        {locationKind === "ssh" && authKind === "key" && (
          <label>
            Identity file path <span className="muted">optional</span>
            <input
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              placeholder="/home/you/.ssh/id_ed25519"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="form-hint">
              Path is on the Shellboard server. Leave empty to use its SSH agent or default identity.
            </span>
          </label>
        )}
        {locationKind === "ssh" && authKind === "password-prompt" && (
          <div className="form-hint">The password is requested by SSH in the terminal and is never saved.</div>
        )}
        {locationKind === "ssh" && (
          <div className="remote-shell-note">
            Remote shell: <strong>Windows PowerShell</strong>; agent command must be available in PATH.
          </div>
        )}
        <label>
          {locationKind === "ssh" ? "Remote root path" : "Root path"}
          <span className="path-row">
            <input
              value={rootPath}
              onChange={(event) => applyRootPath(event.target.value)}
              placeholder={
                locationKind === "ssh"
                  ? "C:\\Users\\you\\projects\\race-platform"
                  : "/home/you/projects/race-platform"
              }
            />
            {locationKind === "local" && (
              <button type="button" onClick={() => setPickerOpen(true)}>
                Browse…
              </button>
            )}
          </span>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={
              busy ||
              !name.trim() ||
              !rootPath.trim() ||
              (locationKind === "ssh" &&
                (!host.trim() ||
                  !username.trim() ||
                  !Number.isInteger(Number(port)) ||
                  Number(port) < 1 ||
                  Number(port) > 65535))
            }
          >
            {project ? "Save" : "Create"}
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
