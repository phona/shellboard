import { useToasts } from "../state/toasts";

export function ToastStack() {
  const toasts = useToasts();
  return (
    <div className="toast-stack">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
