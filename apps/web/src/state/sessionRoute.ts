import { useUi } from "./store";

const HASH_PREFIX = "#/session/";

function parseSessionHash(): string | null {
  if (!window.location.hash.startsWith(HASH_PREFIX)) return null;
  return decodeURIComponent(window.location.hash.slice(HASH_PREFIX.length)) || null;
}

function syncHash(sessionId: string | null): void {
  const next = sessionId ? `${HASH_PREFIX}${encodeURIComponent(sessionId)}` : "#/";
  if (window.location.hash === next) return;
  history.replaceState(null, "", next);
}

/** Wires the selected session to the URL hash (`#/session/<id>`) so a
 *  refresh or a shared link restores the selection. replaceState keeps one
 *  history entry for the app: switching sessions is workspace navigation,
 *  not page navigation. */
export function initSessionRoute(): void {
  const fromHash = parseSessionHash();
  if (fromHash) useUi.getState().selectSession(fromHash);

  // Every selection change (sidebar click, create dialog, session killed,
  // auto-select first) projects into the URL from this single point.
  useUi.subscribe((state, prev) => {
    if (state.selectedSessionId !== prev.selectedSessionId) {
      syncHash(state.selectedSessionId);
    }
  });

  // A shared link pasted into the open tab differs only in the hash, so the
  // browser navigates without a reload. Our own replaceState never fires
  // this; the identity guard keeps a same-id event from clearing openDiff.
  window.addEventListener("hashchange", () => {
    const id = parseSessionHash();
    if (id !== useUi.getState().selectedSessionId) useUi.getState().selectSession(id);
  });
}
