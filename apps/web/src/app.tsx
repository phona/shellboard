import { useEffect } from "react";
import { TokenGate } from "./features/auth/TokenGate";
import { SessionSidebar } from "./features/sessions/SessionSidebar";
import { useEvents } from "./events/useEvents";
import { AppLayout } from "./layout/AppLayout";
import { UploadManager } from "./components/UploadManager";
import { useUi } from "./state/store";
import { ToastStack } from "./components/ToastStack";
import { isTypingTarget, matchesBinding, KEYBINDINGS } from "./util/dom";
import { useCommandMigration } from "./state/useCommands";

export function App() {
  useEvents();
  useCommandMigration();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (matchesBinding(event, KEYBINDINGS.toggleLeft)) {
        event.preventDefault();
        useUi.getState().toggleLeft();
      }
      if (matchesBinding(event, KEYBINDINGS.toggleRight)) {
        event.preventDefault();
        useUi.getState().toggleRight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <TokenGate />
      <AppLayout sidebar={<SessionSidebar />} />
      <ToastStack />
      <UploadManager />
    </>
  );
}
