import { basicSetup, EditorView } from "codemirror";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { toast } from "../../state/toasts";

const RASTER_IMAGE_MIME_TYPES: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function rasterImageMime(path: string): string | null {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return RASTER_IMAGE_MIME_TYPES[extension] ?? null;
}

function MarkdownImageFallback({
  sessionId,
  path,
  alt,
}: {
  sessionId: string;
  path: string;
  alt?: string;
}) {
  return (
    <span className="markdown-image-alt">
      Image preview unavailable:{" "}
      <a href={api.files.downloadUrl(sessionId, path)}>{alt || path}</a>
    </span>
  );
}

function MarkdownImage({
  sessionId,
  path,
  alt,
  title,
}: {
  sessionId: string;
  path: string;
  alt?: string;
  title?: string;
}) {
  const mime = rasterImageMime(path);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "128px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !mime) return;
    const controller = new AbortController();
    void fetch(api.files.downloadUrl(sessionId, path), {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("image request failed");
        const bytes = await response.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        objectUrlRef.current = url;
        setObjectUrl(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [mime, path, sessionId, visible]);

  if (!mime || failed) return <MarkdownImageFallback sessionId={sessionId} path={path} alt={alt} />;
  if (!objectUrl) {
    return (
      <span ref={hostRef} className="markdown-image-alt">
        Loading image: {alt || path}
      </span>
    );
  }
  return (
    <span className="markdown-image">
      <img
        src={objectUrl}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        onError={() => {
          setFailed(true);
          setObjectUrl(null);
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
        }}
      />
    </span>
  );
}

export function FileEditor({
  sessionId,
  path,
  onBack,
  onNavigatePath,
}: {
  sessionId: string;
  path: string;
  onBack: () => void;
  onNavigatePath: (path: string) => void;
}) {
  const isMarkdown = /\.(?:md|markdown)$/i.test(path);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["files", "content", sessionId, path],
    queryFn: () => api.files.content(sessionId, path),
    retry: 0,
  });
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">(isMarkdown ? "preview" : "edit");
  const [mtime, setMtime] = useState<number | null>(null);
  const [pendingExit, setPendingExit] = useState<null | (() => void)>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<string | null>(null);
  const changeRef = useRef<(value: string) => void>(() => {});
  const content = query.data;
  const resolveRelativePath = (reference: string): string | null => {
    if (reference.startsWith("#")) return null;
    try {
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const base = new URL(`https://shellboard.invalid/${directory}`);
      const resolved = new URL(reference, base);
      if (resolved.origin !== base.origin || resolved.pathname === "/") return null;
      return decodeURIComponent(resolved.pathname.slice(1));
    } catch {
      return null;
    }
  };

  changeRef.current = (value: string) => {
    textRef.current = value;
    setText(value);
    setDirty(true);
  };

  useEffect(() => {
    if (!content || content.binary) return;
    textRef.current = content.content;
    setText(content.content);
    setMtime(content.mtime);
    setDirty(false);
  }, [content]);

  useEffect(() => {
    if (mode !== "edit" || !hostRef.current || !content || content.binary) return;
    const view = new EditorView({
      doc: textRef.current ?? content.content,
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
  }, [content, mode]);

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
        {isMarkdown && (
          <button
            type="button"
            disabled={!content || content.binary}
            onClick={() => setMode((current) => (current === "preview" ? "edit" : "preview"))}
          >
            {mode === "preview" ? "Edit" : "Preview"}
          </button>
        )}
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
        {content && !content.binary && mode === "edit" && (
          <div ref={hostRef} className="cm-host" />
        )}
        {content && !content.binary && isMarkdown && mode === "preview" && (
          <div className="markdown-preview">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, title }) => {
                  const localPath = href ? resolveRelativePath(href) : null;
                  const isMarkdownLink = localPath !== null && /\.(?:md|markdown)$/i.test(localPath);
                  const destination =
                    localPath === null ? href : api.files.downloadUrl(sessionId, localPath);
                  return (
                    <a
                      href={destination}
                      title={title}
                      onClick={
                        isMarkdownLink
                          ? (event) => {
                              event.preventDefault();
                              guard(() => onNavigatePath(localPath))();
                            }
                          : undefined
                      }
                    >
                      {children}
                    </a>
                  );
                },
                img: ({ src, alt, title }) => {
                  const localPath = src ? resolveRelativePath(src) : null;
                  if (localPath) {
                    return (
                      <MarkdownImage
                        key={localPath}
                        sessionId={sessionId}
                        path={localPath}
                        alt={alt}
                        title={title}
                      />
                    );
                  }
                  return src ? <img src={src} alt={alt ?? ""} title={title} loading="lazy" /> : null;
                },
              }}
            >
              {text ?? content.content}
            </ReactMarkdown>
          </div>
        )}
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
