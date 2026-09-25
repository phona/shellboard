import { useEffect, useRef, useState } from "react";
import { getThemeMode, setThemeMode, type ThemeMode } from "../state/theme";
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
        </div>
      )}
    </div>
  );
}
