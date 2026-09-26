export const KEYBINDINGS = {
  search: "/",
  toggleLeft: "Ctrl+b",
  toggleRight: "Ctrl+Shift+b",
  exitMaximize: "Escape",
  terminalSearch: "Ctrl+f",
  terminalCopy: "Ctrl+c",
  terminalPaste: "Ctrl+v",
  terminalPasteShift: "Ctrl+Shift+v",
  terminalBottom: "Ctrl+End",
  terminalPageUp: "Shift+PageUp",
  terminalPageDown: "Shift+PageDown",
} as const;

export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey === parts.includes("ctrl") &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey === parts.includes("alt")
  );
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    target.closest(".xterm") !== null
  );
}

export function joinPosix(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

export function parentPosix(dir: string): string {
  if (dir === "." || !dir.includes("/")) return ".";
  return dir.slice(0, dir.lastIndexOf("/")) || ".";
}

export function basenamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(index + 1);
}
