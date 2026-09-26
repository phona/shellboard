import { basicSetup, EditorView } from "codemirror";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { toast } from "../../state/toasts";

export function FileEditor({
  sessionId,
  path,
  onBack,
}: {
  sessionId: string;
  path: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["files", "content", sessionId, path],
    queryFn: () => api.files.content(sessionId, path),
    retry: 0,
  });
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mtime, setMtime] = useState<number | null>(null);
  const [pendingExit, setPendingExit] = useState<null | (() => void)>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const changeRef = useRef<(value: string) => void>(() => {});
  const content = query.data;

  changeRef.current = (value: string) => {
    setText(value);
    setDirty(true);
  };

  useEffect(() => {
    if (!hostRef.current || !content || content.binary) return;
    setText(content.content);
    setMtime(content.mtime);
    setDirty(false);
    const view = new EditorView({
      doc: content.content,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            changeRef.current(update.state.doc.toString());
          }
        }),
      ],
      parent: hostRef.current,
    });
    return () => view.destroy();
  }, [content]);

  // Unsaved edits are lost on any exit that unmounts the editor (refresh, tab
  // close, navigation, session switch). Block browser-level exits while dirty;
  // in-app exits go through the confirmation below.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.files.save(sessionId, path, {
        content: text ?? "",
        encoding: "utf8",
        mtime: mtime ?? undefined,
      }),
    onSuccess: (result) => {
      setDirty(false);
      setMtime(result.mtime);
      toast("saved");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast("file changed on disk — reload to continue (discards unsaved edits)", "error");
      } else {
        toast(err instanceof ApiError ? err.message : "save failed", "error");
      }
    },
  });

  const reload = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["files", "content", sessionId, path],
    });
  };

  // Any exit that discards edits asks first when the buffer is dirty.
  const guard = (action: () => void) => () => {
    if (dirty) setPendingExit(() => action);
    else action();
  };

  const download = () => {
    window.location.href = api.files.downloadUrl(sessionId, path);
  };

  return (
    <>
      <div className="editor-toolbar">
        <button type="button" className="icon-btn" title="Back" onClick={guard(onBack)}>
          ←
        </button>
        <span className="path">{path}</span>
        <span style={{ flex: 1 }} />
        {dirty && <span className="muted">unsaved</span>}
        <button type="button" onClick={guard(() => void reload())}>
          Reload
        </button>
        <button type="button" onClick={download}>
          Download
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </div>
      <div className="editor-host">
        {query.isLoading && <div className="tool-placeholder">loading…</div>}
        {query.isError && (
          <div className="tool-placeholder">
            {query.error instanceof ApiError ? query.error.message : "cannot open file"}
          </div>
        )}
        {content?.binary && (
          <div className="tool-placeholder">
            Binary file ({content.size} bytes) — use download.
          </div>
        )}
        {content && !content.binary && <div ref={hostRef} className="cm-host" />}
      </div>

      {pendingExit && (
        <Modal title="Discard unsaved edits?" onClose={() => setPendingExit(null)}>
          <div>
            You have unsaved changes in <strong>{path}</strong>. Leaving now discards them. This
            cannot be undone.
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setPendingExit(null)}>
              Keep editing
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                const exit = pendingExit;
                setPendingExit(null);
                exit();
              }}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
