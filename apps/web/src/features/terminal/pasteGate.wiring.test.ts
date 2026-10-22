import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The paste gate is a state machine with two entry points and one dialog, and
// both halves have already shipped broken once:
//
//   1. Enter cancelled. Modal claims focus for the first focusable in the card
//      unless something inside already has it, and the header's × comes first
//      in DOM order — so the primary button had to ask for focus itself.
//   2. The gate existed twice: once inside the connect effect (Ctrl+V,
//      right-click) and once in the exposed paste() (toolbar button). They
//      agreed by luck. One gate means they cannot drift.
//
// Neither the hook (no DOM, no xterm) nor the dialog (vitest runs .ts only,
// node environment) can be mounted here, so the wiring is asserted
// structurally — the same trade inputModes.wiring.test.ts makes.
const hookSource = readFileSync(new URL("./useTerminalWs.ts", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");

describe("the paste confirmation dialog", () => {
  const dialog = viewSource.slice(
    viewSource.indexOf("pendingPaste && ("),
    viewSource.indexOf("{banner && ("),
  );

  it("renders the shared send confirmation, not a dialog of its own", () => {
    // One dialog for everything handed to a shell. A second copy would drift
    // from the upload buffer's path confirmation on what "sending" means —
    // the same failure mode as the gate existing twice.
    expect(dialog).toContain("<SendConfirmModal");
    expect(dialog).not.toContain('className="btn primary"');
  });

  it("wires confirm and cancel to the gate", () => {
    expect(dialog).toContain("onConfirm={terminal.confirmPaste}");
    // Escape and the backdrop both arrive as the dialog's onClose, which the
    // shared component routes to cancel.
    expect(dialog).toContain("onCancel={terminal.cancelPaste}");
  });

  it("states what the dialog is about to send", () => {
    expect(dialog).toContain("lines to the shell?");
    expect(dialog).toContain("formatSize(pendingPaste.bytes)");
    // Lines beyond the preview, counted rather than assumed.
    expect(dialog).toContain("hiddenLines");
    expect(dialog).toContain("execute line by line");
  });
});

describe("the paste gate has one implementation", () => {
  it("arms the confirmation in exactly one place", () => {
    // Clearing it (cancel, confirm) is not arming it; only the gate arms.
    expect(hookSource.match(/setPasteConfirmation\(pendingPasteDetails\(/g)?.length).toBe(1);
  });

  it("routes every entry point through it", () => {
    // The native paste event (Ctrl+V, middle click, browser menu) and the two
    // clipboard-reading paths (right-click, the toolbar button).
    expect(hookSource).toContain('container.addEventListener("paste", onPaste, true)');
    expect(hookSource.match(/\.then\(gatePaste\)/g)?.length).toBe(2);
    expect(hookSource).toContain("const gatePaste = useCallback");
  });

  it("cancels the native paste event, so the pane cannot receive it ungated", () => {
    // The regression this guards: xterm's key handler returning false does not
    // preventDefault, so the browser's own paste used to land in xterm's
    // textarea and its `input` handler forwarded the text to the PTY before
    // the dialog ever opened.
    const listener = hookSource.slice(hookSource.indexOf("const onPaste"));
    const body = listener.slice(0, listener.indexOf("};"));
    expect(body).toContain("event.preventDefault()");
    expect(body).toContain("event.stopPropagation()");
    expect(body).toContain('getData("text/plain")');
  });

  it("keeps the paste keys out of the pane, without cancelling them", () => {
    // The regression this guards: dropping this branch entirely lets xterm's
    // keyboard map evaluate Ctrl+V to \x16 (SYN) and send a literal ^V to the
    // shell, and because xterm then cancels the keydown, no paste event ever
    // fires — pasting stops working in the web terminal altogether.
    //
    // Equally, the branch must not cancel the event or read the clipboard
    // itself: returning false is what lets the browser's own paste event fire,
    // and that event is the gate.
    const branch = hookSource.slice(hookSource.indexOf("KEYBINDINGS.terminalPaste"));
    const body = branch.slice(0, branch.indexOf("KEYBINDINGS.terminalBottom"));
    expect(body).toContain("return false");
    expect(body).not.toContain("preventDefault");
    expect(body).not.toContain("readAndGate");
  });

  it("still lets single-line paste through ungated", () => {
    expect(hookSource).toContain('if (!text.includes("\\n"))');
  });

  it("keeps the pending text for the confirm path to send", () => {
    const gate = hookSource.slice(hookSource.indexOf("const gatePaste"));
    const body = gate.slice(0, gate.indexOf("}, []);"));
    expect(body).toContain("pendingPasteRef.current = text");
  });
});
