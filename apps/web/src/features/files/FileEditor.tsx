import { basicSetup, EditorView } from "codemirror";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
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
        toast("file changed on disk — reload to continue", "error");
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

  const download = () => {
    window.location.href = api.files.downloadUrl(sessionId, path);
  };

  return (
    <>
      <div className="editor-toolbar">
        <button type="button" className="icon-btn" title="Back" onClick={onBack}>
          ←
        </button>
        <span className="path">{path}</span>
        <span style={{ flex: 1 }} />
        {dirty && <span className="muted">unsaved</span>}
        <button type="button" onClick={() => void reload()}>
          reload
        </button>
        <button type="button" onClick={download}>
          download
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
    </>
  );
}
