import { dismiss, useToasts } from "../state/toasts";

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
          <span>{item.message}</span>
          {item.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const action = item.action;
                dismiss(item.id);
                action?.onClick();
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
