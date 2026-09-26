import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

// Burst cap: a failed batch (multi-file upload, several mutations at once)
// must not flood the corner. Newest wins; the stack never grows past this.
const MAX_TOASTS = 4;

function emit(): void {
  for (const listener of listeners) listener();
}

export function dismiss(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const item: Toast = { id: nextId++, message, kind };
  toasts = [...toasts, item].slice(-MAX_TOASTS);
  emit();
  window.setTimeout(() => dismiss(item.id), 4000);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}
