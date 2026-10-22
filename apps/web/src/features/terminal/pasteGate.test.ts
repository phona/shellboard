import { describe, expect, it } from "vitest";
import { pendingPasteDetails } from "./pasteGate";

/** ESC, built rather than written: a raw control byte in source is
    unreadable in review and diffs. */
const ESC = String.fromCharCode(27);

// The dialog states exactly what is about to be handed to a shell, so these
// numbers are the feature: a wrong line count or a preview that hides what the
// first line really is turns a confirmation into a rubber stamp.
describe("pendingPasteDetails", () => {
  it("counts every line, including the trailing empty one", () => {
    expect(pendingPasteDetails("a\nb\n").lines).toBe(3);
    expect(pendingPasteDetails("a\nb").lines).toBe(2);
  });

  it("measures bytes, not characters", () => {
    // "é" is 2 bytes in UTF-8; a character count would understate the payload.
    expect(pendingPasteDetails("é\n").bytes).toBe(3);
    expect(pendingPasteDetails("abc\n").bytes).toBe(4);
  });

  it("previews the first line only", () => {
    expect(pendingPasteDetails("for f in *.ts\ndo fmt\ndone").preview).toBe("for f in *.ts");
  });

  it("strips control characters out of the preview", () => {
    // A CRLF paste would otherwise leave the preview looking empty, and an ESC
    // would put a real escape sequence into dialog text.
    expect(pendingPasteDetails("echo hi\r\nrm -rf /\n").preview).toBe("echo hi");
    expect(pendingPasteDetails(`${ESC}[31mred\n`).preview).toBe("[31mred");
  });

  it("elides a long first line", () => {
    const long = "x".repeat(200);
    const details = pendingPasteDetails(`${long}\nsecond\n`);
    expect(details.preview).toBe(`${"x".repeat(80)}…`);
    expect(details.lines).toBe(3);
  });

  it("keeps a short first line intact", () => {
    expect(pendingPasteDetails("git push\n").preview).toBe("git push");
  });

  it("survives text with no newline at all", () => {
    const details = pendingPasteDetails("no newline here");
    expect(details).toEqual({ lines: 1, bytes: 15, preview: "no newline here" });
  });
});
