export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "shellboard.theme";
const THEME_EVENT = "sb-theme-change";

export function getThemeMode(): ThemeMode {
  const value = localStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? systemTheme() : mode;
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(getThemeMode());
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme();
}

export function initTheme(): void {
  applyTheme();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (getThemeMode() === "system") applyTheme();
    });
}

export function subscribeTheme(callback: () => void): () => void {
  window.addEventListener(THEME_EVENT, callback);
  return () => window.removeEventListener(THEME_EVENT, callback);
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

export function readTerminalTheme(): TerminalTheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--term-bg", "#0d1117"),
    foreground: read("--term-fg", "#e6edf3"),
    cursor: read("--term-cursor", "#e6edf3"),
    cursorAccent: read("--term-bg", "#0d1117"),
    selectionBackground: read("--term-selection", "rgba(9, 105, 218, 0.35)"),
  };
}
