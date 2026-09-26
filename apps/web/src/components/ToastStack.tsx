import { useToasts } from "../state/toasts";

export function ToastStack() {
  const toasts = useToasts();
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div
          key={item.id}
          className={`toast ${item.kind}`}
          role={item.kind === "error" ? "alert" : undefined}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
