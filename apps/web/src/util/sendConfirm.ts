import { formatSize } from "./format.js";

/** What the send-path confirmation reports, so the dialog can state exactly what
    is about to be typed into the pane: the absolute path the server will send,
    the file it belongs to, and why that is safe to hand over. */
export interface SendPathConfirmation {
  title: string;
  /** The payload, verbatim — what `tmux send-keys -l` will type. */
  payload: string;
  /** The file behind the path, with its size when the caller knows it. */
  meta: string;
  risk: string;
}

/** The copy for "type this buffer path into the agent shell". Pure — no store, no
    DOM — so the wording is testable on its own, the same trade
    features/terminal/pasteGate.ts makes for the paste gate. */
export function sendPathConfirmation(input: {
  path: string;
  name: string;
  size: number | null;
}): SendPathConfirmation {
  const meta = input.size === null ? input.name : `${input.name} · ${formatSize(input.size)}`;
  return {
    title: "Send this path to the shell?",
    payload: input.path,
    meta,
    // The honest accounting of the D6 carve-out: the path lands in the input
    // line and nothing else happens — submitting stays the user's keystroke.
    risk: "Types the path into the pane without Enter — nothing runs until you submit.",
  };
}
