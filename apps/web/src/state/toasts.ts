import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function dismiss(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const item: Toast = { id: nextId++, message, kind };
  toasts = [...toasts, item];
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
