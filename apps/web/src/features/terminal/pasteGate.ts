/** First line shown in the paste confirmation, before it is elided. */
const PREVIEW_LIMIT = 80;

/** What the paste gate reports, so the dialog can state exactly what is about
    to be handed to the shell: the line count, the byte size, and the first
    line for review. */
export interface PasteConfirmation {
  lines: number;
  bytes: number;
  preview: string;
}

/** Clipboard text as the dialog needs it. Pure — no terminal, no DOM — so the
    formatting is testable on its own.

    Control characters are replaced with a space rather than kept: clipboard
    content routinely carries ANSI escapes and CRs, and a raw ESC in the middle
    of the preview would be both unreadable and a way to smuggle escape
    sequences into a surface that never asked for them. */
export function pendingPasteDetails(text: string): PasteConfirmation {
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const preview = firstLine.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return {
    lines: text.split("\n").length,
    bytes: new TextEncoder().encode(text).length,
    preview: preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}…` : preview,
  };
}
