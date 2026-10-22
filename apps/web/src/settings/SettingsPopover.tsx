import { useEffect, useRef, useState } from "react";
import type { Command } from "@shellboard/contracts";
import { getThemeMode, setThemeMode, type ThemeMode } from "../state/theme";
import {
  useCommands,
  useCreateCommand,
  useRemoveCommand,
  useUpdateCommand,
} from "../state/useCommands";
import {
  envSummary,
  pairsToRecord,
  recordToPairs,
  type EnvPair,
} from "../state/env";
import { useUi } from "../state/store";
import { ApiError } from "../api/client";
import { EnvEditor } from "../components/EnvEditor";

export function SettingsPopover({ inline = false }: { inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (inline) {
    return (
      <details className="settings-inline">
        <summary>Settings</summary>
        <div className="settings-inline-content">
          <SettingsControls mode={mode} setMode={setMode} />
        </div>
      </details>
    );
  }

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => setOpen((value) => !value)}
      >
        ⚙
      </button>
      {open && (
        <div className="popover">
          <SettingsControls mode={mode} setMode={setMode} />
        </div>
      )}
    </div>
  );
}

function SettingsControls({
  mode,
  setMode,
}: {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}) {
  const fontSize = useUi((state) => state.fontSize);
  const scrollback = useUi((state) => state.scrollback);
  const notifications = useUi((state) => state.notifications);

  return (
    <>
      <label>
        Theme
        <select
          value={mode}
          onChange={(event) => {
            const value = event.target.value as ThemeMode;
            setMode(value);
            setThemeMode(value);
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Font size
        <span className="stepper">
          <button
            type="button"
            aria-label="Decrease font size"
            onClick={() => useUi.getState().setFontSize(fontSize - 1)}
          >
            −
          </button>
          {fontSize}px
          <button
            type="button"
            aria-label="Increase font size"
            onClick={() => useUi.getState().setFontSize(fontSize + 1)}
          >
            +
          </button>
        </span>
      </label>
      <label>
        Initial history
        <select
          title="History loaded when a terminal connects. Deeper history loads on demand as you scroll to the top — no page reload needed."
          value={scrollback}
          onChange={(event) => useUi.getState().setScrollback(Number(event.target.value))}
        >
          <option value={1000}>1 000</option>
          <option value={5000}>5 000</option>
          <option value={10000}>10 000</option>
          <option value={20000}>20 000</option>
        </select>
      </label>
      <label>
        Notify on working → idle
        <input
          type="checkbox"
          checked={notifications}
          onChange={(event) => useUi.getState().setNotifications(event.target.checked)}
        />
      </label>
      <CommandRegistry />
    </>
  );
}

/** Register launch commands once, pick them from the new-session dialog.
    Persisted server-side (D9), so the list survives a browser change and can
    carry environment variables. */
function CommandRegistry() {
  const query = useCommands();
  const commands = query.data ?? [];
  const create = useCreateCommand();
  const update = useUpdateCommand();
  const remove = useRemoveCommand();

  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState<EnvPair[]>([]);
  /** Set by the env editor: a bulk line that is not an assignment cannot be
      represented as a pair, so Save stays off until the text parses. */
  const [envValid, setEnvValid] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const busy = create.isPending || update.isPending;

  function reset() {
    setEditing(null);
    setName("");
    setCommand("");
    setEnv([]);
    setEnvValid(true);
    setError(null);
  }

  function startEdit(item: Command) {
    setEditing(item.id);
    setName(item.name);
    setCommand(item.command);
    setEnv(recordToPairs(item.env));
    setEnvValid(true);
    setError(null);
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const cmd = command.trim();
    if (!cmd) return;
    const payload = {
      name: name.trim() || cmd.split(/\s+/)[0]?.toLowerCase() || "command",
      command: cmd,
      env: pairsToRecord(env),
    };
    setError(null);
    const run = editing
      ? update.mutateAsync({ id: editing, ...payload })
      : create.mutateAsync(payload);
    void run.then(reset).catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "save failed");
    });
  };

  return (
    <div className="command-registry">
      <div className="popover-title">Registered commands</div>
      {query.isPending && <div className="command-empty">loading…</div>}
      {query.isError && (
        <div className="form-error">
          {query.error instanceof ApiError ? query.error.message : "could not load commands"}
        </div>
      )}
      {commands.map((item) =>
        editing === item.id ? (
          <CommandForm
            key={item.id}
            name={name}
            command={command}
            env={env}
            envValid={envValid}
            error={error}
            busy={busy}
            submitLabel="Save"
            onName={setName}
            onCommand={setCommand}
            onEnv={setEnv}
            onEnvValidity={setEnvValid}
            onSubmit={submit}
            onCancel={reset}
          />
        ) : (
          <div className="command-row" key={item.id}>
            <span className="command-name" title={`${item.command}${envTitle(item.env)}`}>
              {item.name}
              {item.env && Object.keys(item.env).length > 0 && (
                <span className="command-env">{envSummary(item.env)}</span>
              )}
            </span>
            <span className="command-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label={`Edit ${item.name}`}
                onClick={() => startEdit(item)}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${item.name}`}
                onClick={() => remove.mutate(item.id)}
              >
                ×
              </button>
            </span>
          </div>
        ),
      )}
      {editing === null && (
        <CommandForm
          name={name}
          command={command}
          env={env}
          envValid={envValid}
          error={error}
          busy={busy}
          submitLabel="Add"
          onName={setName}
          onCommand={setCommand}
          onEnv={setEnv}
          onEnvValidity={setEnvValid}
          onSubmit={submit}
          onCancel={undefined}
        />
      )}
      {commands.length > 0 && (
        <div className="command-hint">
          Stored on the server; a session snapshots its command and environment when it
          starts.
        </div>
      )}
    </div>
  );
}

function envTitle(env: Command["env"]): string {
  const summary = envSummary(env);
  return summary.length > 0 ? `\n${summary}` : "";
}

function CommandForm({
  name,
  command,
  env,
  envValid,
  error,
  busy,
  submitLabel,
  onName,
  onCommand,
  onEnv,
  onEnvValidity,
  onSubmit,
  onCancel,
}: {
  name: string;
  command: string;
  env: EnvPair[];
  envValid: boolean;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onName: (value: string) => void;
  onCommand: (value: string) => void;
  onEnv: (pairs: EnvPair[]) => void;
  onEnvValidity: (valid: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: (() => void) | undefined;
}) {
  return (
    <form className="command-add" onSubmit={onSubmit}>
      <input
        value={name}
        onChange={(event) => onName(event.target.value)}
        placeholder="name (optional)"
        aria-label="Command name"
      />
      <input
        value={command}
        onChange={(event) => onCommand(event.target.value)}
        placeholder="command to run"
        aria-label="Command"
        required
      />
      <div className="dialog-section">Environment</div>
      <EnvEditor
        pairs={env}
        onChange={onEnv}
        onValidityChange={onEnvValidity}
        namePrefix="cmd-env"
      />
      {error && <div className="form-error">{error}</div>}
      <div className="command-form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn" disabled={busy || !envValid}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
