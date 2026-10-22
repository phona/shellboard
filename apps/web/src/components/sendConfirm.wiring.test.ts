import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The send-path confirmation is the upload buffer's half of the one dialog that
// hands a payload to a shell (components/SendConfirm.tsx). Two things have
// already shipped broken in its sibling:
//
//   1. Enter cancelled, because Modal claims focus for the first focusable in
//      the card unless something inside already has it, and the header's ×
//      comes first in DOM order.
//   2. The gate existed twice and the two copies agreed by luck.
//
// Neither the dialog (vitest runs .ts only, node environment) nor the store's
// React binding can be mounted here, so the wiring is asserted structurally —
// the same trade features/terminal/pasteGate.wiring.test.ts makes.
const dialogSource = readFileSync(new URL("./SendConfirm.tsx", import.meta.url), "utf8");
const managerSource = readFileSync(new URL("./UploadManager.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(
  new URL("../features/files/FilesPanel.tsx", import.meta.url),
  "utf8",
);

describe("the send confirmation dialog", () => {
  const card = dialogSource.slice(
    dialogSource.indexOf("export function SendConfirmModal"),
    dialogSource.indexOf("export function SendPathModal"),
  );

  it("puts Enter on Send, not on the header's close button", () => {
    const send = card.slice(card.indexOf('className="btn primary"'));
    const openingTag = send.slice(0, send.indexOf(">"));
    expect(openingTag).toContain("autoFocus");
    expect(openingTag).toContain("onConfirm");
  });

  it("keeps Escape and the backdrop on the cancel path", () => {
    expect(card).toContain("onClose={onCancel}");
  });

  it("shows the exact payload, what it costs, and the risk", () => {
    expect(card).toContain('className="send-confirm-payload"');
    expect(card).toContain("{meta}");
    expect(card).toContain("{risk}");
    expect(card).toContain("send-confirm-keys");
  });
});

describe("the path send goes through it", () => {
  it("is mounted once, where the uploads live", () => {
    expect(managerSource).toContain("<SendPathModal />");
  });

  it("reads and answers the store's pending send", () => {
    expect(dialogSource).toContain("useUploads.getState().confirmSend()");
    expect(dialogSource).toContain("useUploads.getState().cancelSend()");
  });

  it("asks from the buffer list too, so no send fires on one click", () => {
    expect(panelSource).toContain("onClick={() => requestSendPath(entry)}");
    // The direct send used to live here as a mutation; nothing in the panel may
    // reach the API any more.
    expect(panelSource).not.toContain("sendUpload");
    expect(panelSource).not.toContain("api.uploads.send");
  });
});
