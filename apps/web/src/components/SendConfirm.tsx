import { Modal } from "./Modal";
import { useUploads } from "../state/uploads";
import { sendPathConfirmation } from "../util/sendConfirm";

/**
 * The one dialog that hands a payload to a shell. It shows the exact payload,
 * counts what it cannot show, states the risk, and puts Enter on Send. Both
 * send paths render it — the terminal's multi-line paste gate and the upload
 * buffer's path injection — so they cannot drift apart on what "sending" means.
 */
export function SendConfirmModal({
  title,
  payload,
  meta,
  risk,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** The payload, verbatim. Empty means there is nothing worth showing. */
  payload: string;
  /** Counts and sizes the payload alone does not carry. */
  meta: string;
  risk: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="send-confirm">
        {payload && <div className="send-confirm-payload">{payload}</div>}
        <div className="send-confirm-meta">{meta}</div>
        <div className="send-confirm-risk">{risk}</div>
        <div className="send-confirm-keys">
          <kbd>Enter</kbd> send <span className="muted">·</span> <kbd>Esc</kbd> discard
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>
          Discard
        </button>
        {/* autoFocus puts Enter on Send. Modal only claims focus itself when
            nothing inside the card has it, so without this the first focusable
            — the header's × — takes Enter and cancels. */}
        <button type="button" className="btn primary" autoFocus onClick={onConfirm}>
          Send
        </button>
      </div>
    </Modal>
  );
}

/**
 * The upload buffer's half. A path send is session-scoped rather than
 * terminal-scoped (either terminal may be the one on screen), so the pending
 * send lives in the uploads store and this dialog is mounted once at the root.
 */
export function SendPathModal() {
  const pending = useUploads((state) => state.pending);
  if (!pending) return null;
  const details = sendPathConfirmation(pending);
  return (
    <SendConfirmModal
      title={details.title}
      payload={details.payload}
      meta={details.meta}
      risk={details.risk}
      onConfirm={() => useUploads.getState().confirmSend()}
      onCancel={() => useUploads.getState().cancelSend()}
    />
  );
}
