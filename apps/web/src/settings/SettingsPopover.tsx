import { useEffect, useRef, useState } from "react";
import { getThemeMode, setThemeMode, type ThemeMode } from "../state/theme";
import { useCommands } from "../state/commands";
import { useUi } from "../state/store";

export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const fontSize = useUi((state) => state.fontSize);
  const scrollback = useUi((state) => state.scrollback);
  const notifications = useUi((state) => state.notifications);
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

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        title="Settings"
        onClick={() => setOpen((value) => !value)}
      >
        ⚙
      </button>
      {open && (
        <div className="popover">
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
                onClick={() => useUi.getState().setFontSize(fontSize - 1)}
              >
                −
              </button>
              {fontSize}px
              <button
                type="button"
                onClick={() => useUi.getState().setFontSize(fontSize + 1)}
              >
                +
              </button>
            </span>
          </label>
          <label>
            Scrollback
            <select
              value={scrollback}
              onChange={(event) =>
                useUi.getState().setScrollback(Number(event.target.value))
              }
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
              onChange={(event) =>
                useUi.getState().setNotifications(event.target.checked)
              }
            />
          </label>
          <CommandRegistry />
        </div>
      )}
    </div>
  );
}

/** Register launch commands once, pick them from the new-session dialog. */
function CommandRegistry() {
  const commands = useCommands((state) => state.commands);
  const remove = useCommands((state) => state.remove);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  return (
    <div className="command-registry">
      <div className="popover-title">Registered commands</div>
      {commands.map((item) => (
        <div className="command-row" key={item.name}>
          <span className="command-name" title={item.command}>
            {item.name}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${item.name}`}
            onClick={() => remove(item.name)}
          >
            ×
          </button>
        </div>
      ))}
      <form
        className="command-add"
        onSubmit={(event) => {
          event.preventDefault();
          const cmd = command.trim();
          if (!cmd) return;
          const fallback = cmd.split(/\s+/)[0]?.toLowerCase() ?? "command";
          useCommands.getState().add(name.trim() || fallback, cmd);
          setName("");
          setCommand("");
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="name (optional)"
        />
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="command to run"
          required
        />
        <button type="submit" className="btn">
          Add
        </button>
      </form>
    </div>
  );
}
