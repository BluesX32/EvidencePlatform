/**
 * PDFViewerPanel — floating, draggable PDF viewer with an inline annotation drawer.
 *
 * - Drag the header to reposition the panel anywhere on screen.
 * - Drag the left edge to resize width (280–900 px).
 * - The "Notes" drawer at the bottom persists annotations to the database via the
 *   existing annotationsApi (same cache key as AnnotationsPanel in PaperCard, so
 *   both views stay in sync).
 * - Free-form text notes are stored with selected_text = "" so the API contract
 *   is satisfied; the UI labels them as "PDF note" to distinguish from text highlights.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fulltextApi, annotationsApi } from "../api/client";
import type { FulltextPdfMeta, ScreeningNextItem, Annotation } from "../api/client";

interface Props {
  projectId: string;
  item: ScreeningNextItem;
  onClose: () => void;
}

// Initial dimensions / position
const INIT_WIDTH = 480;
const INIT_HEIGHT_OFFSET = 56; // px from top (below app header)
const INIT_RIGHT = 0;

export function PDFViewerPanel({ projectId, item, onClose }: Props) {
  const qc = useQueryClient();
  const itemKey = item.record_id ?? item.cluster_id;

  // ── PDF metadata (shared cache with PDFUploadPanel) ────────────────────────
  const { data: meta } = useQuery<FulltextPdfMeta | null>({
    queryKey: ["fulltext-pdf", projectId, itemKey],
    queryFn: () =>
      fulltextApi
        .getMeta(projectId, { record_id: item.record_id, cluster_id: item.cluster_id })
        .then((r) => r.data),
    enabled: !!itemKey,
    staleTime: 60_000,
  });

  // ── Annotations (shared cache with AnnotationsPanel in PaperCard) ──────────
  const { data: annotations = [] } = useQuery<Annotation[]>({
    queryKey: ["annotations", itemKey],
    queryFn: () =>
      annotationsApi
        .list(projectId, {
          record_id: item.record_id ?? undefined,
          cluster_id: item.cluster_id ?? undefined,
        })
        .then((r) => r.data),
    enabled: !!itemKey,
  });

  const [noteDraft, setNoteDraft] = useState("");
  // Pass comment as a variable to mutate() — avoids stale closure over noteDraft
  const createMut = useMutation({
    mutationFn: (comment: string) =>
      annotationsApi.create(projectId, {
        record_id: item.record_id ?? null,
        cluster_id: item.cluster_id ?? null,
        selected_text: "",
        comment,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["annotations", itemKey] });
      setNoteDraft("");
    },
  });

  function submitNote() {
    const comment = noteDraft.trim();
    if (!comment) return;
    createMut.mutate(comment);
  }

  function deleteAnnotation(annId: string) {
    annotationsApi.delete(projectId, annId).then(() =>
      qc.invalidateQueries({ queryKey: ["annotations", itemKey] })
    );
  }

  // ── Blob URL for iframe ────────────────────────────────────────────────────
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const prevUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!meta?.id) return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError("");
    fulltextApi
      .download(projectId, meta.id)
      .then((res) => {
        if (cancelled) return;
        if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
        const url = URL.createObjectURL(res.data);
        prevUrl.current = url;
        setBlobUrl(url);
        setPdfLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setPdfError(err?.message || "Failed to load PDF");
        setPdfLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, meta?.id]);

  useEffect(() => () => { if (prevUrl.current) URL.revokeObjectURL(prevUrl.current); }, []);

  // ── Panel position & size ──────────────────────────────────────────────────
  // We initialise position lazily on first render using window dimensions.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [width, setWidth] = useState(INIT_WIDTH);
  const [minimized, setMinimized] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);

  // Set initial position once (right-aligned, below header)
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pos === null) {
      setPos({
        left: window.innerWidth - INIT_WIDTH - INIT_RIGHT,
        top: INIT_HEIGHT_OFFSET,
      });
    }
  }, [pos]);

  // ── Header drag-to-move ────────────────────────────────────────────────────
  const moveStart = useRef<{ mx: number; my: number; left: number; top: number } | null>(null);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" || (e.target as HTMLElement).tagName === "A") return;
    e.preventDefault();
    if (!pos) return;
    moveStart.current = { mx: e.clientX, my: e.clientY, left: pos.left, top: pos.top };

    const onMove = (me: MouseEvent) => {
      if (!moveStart.current) return;
      const dx = me.clientX - moveStart.current.mx;
      const dy = me.clientY - moveStart.current.my;
      const newLeft = Math.max(0, Math.min(window.innerWidth - width, moveStart.current.left + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 60, moveStart.current.top + dy));
      setPos({ left: newLeft, top: newTop });
    };
    const onUp = () => {
      moveStart.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pos, width]);

  // ── Left-edge drag-to-resize ───────────────────────────────────────────────
  const resizeStart = useRef<{ mx: number; initW: number; initLeft: number } | null>(null);

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!pos) return;
    resizeStart.current = { mx: e.clientX, initW: width, initLeft: pos.left };

    const onMove = (me: MouseEvent) => {
      if (!resizeStart.current) return;
      const delta = resizeStart.current.mx - me.clientX;
      const next = Math.min(900, Math.max(280, resizeStart.current.initW + delta));
      setWidth(next);
      setPos((p) => p ? { ...p, left: resizeStart.current!.initLeft - (next - resizeStart.current!.initW) } : p);
    };
    const onUp = () => {
      resizeStart.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Don't render until position is computed (avoids flash at wrong spot)
  if (pos === null) return null;

  const filename = meta?.original_filename ?? "";
  const displayName = filename.length > 34 ? filename.slice(0, 31) + "…" : filename;

  // ── Styles ─────────────────────────────────────────────────────────────────
  const NOTES_H = 220; // notes drawer height px

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    width: `${width}px`,
    height: minimized ? "auto" : "calc(100vh - 3.5rem)",
    maxHeight: minimized ? undefined : `calc(100vh - ${pos.top}px)`,
    zIndex: 300,
    background: "#fff",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    display: "flex",
    flexDirection: "column",
    borderRadius: "0.5rem",
    border: "1px solid #e2e8f0",
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.45rem",
    padding: "0.4rem 0.65rem",
    background: "#4f46e5",
    color: "#fff",
    fontSize: "0.78rem",
    fontWeight: 600,
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
  };

  const iconBtn: React.CSSProperties = {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    fontSize: "0.85rem",
    padding: "0.1rem 0.3rem",
    borderRadius: "0.25rem",
    lineHeight: 1,
  };

  const dragHandle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "5px",
    cursor: "ew-resize",
    zIndex: 1,
    background: "transparent",
  };

  return (
    <div ref={panelRef} style={panelStyle} aria-label="PDF viewer panel">
      {/* Resize handle */}
      {!minimized && <div style={dragHandle} onMouseDown={onResizeMouseDown} />}

      {/* ── Header (drag to move) ── */}
      <div style={headerStyle} onMouseDown={onHeaderMouseDown}>
        <span style={{ fontSize: "0.9rem", pointerEvents: "none" }}>📄</span>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pointerEvents: "none" }}
          title={filename || "PDF Viewer"}
        >
          {displayName || "PDF Viewer"}
        </span>
        <button style={iconBtn} title={minimized ? "Expand" : "Minimise"} onClick={() => setMinimized((v) => !v)}>
          {minimized ? "▲" : "▼"}
        </button>
        {blobUrl && !minimized && (
          <a href={blobUrl} download={filename} style={{ ...iconBtn, textDecoration: "none" }} title="Download PDF">⬇</a>
        )}
        <button style={iconBtn} title="Close viewer" onClick={onClose}>✕</button>
      </div>

      {!minimized && (
        <>
          {/* ── PDF area ── */}
          <div style={{ flex: 1, overflow: "hidden", position: "relative", background: "#f1f5f9", minHeight: 0 }}>
            {!meta && !pdfLoading && (
              <div style={centeredMsg}>
                <span style={{ fontSize: "2rem" }}>📂</span>
                No PDF uploaded yet.
                <br />
                Use the PDF panel above to upload a file.
              </div>
            )}
            {pdfLoading && (
              <div style={centeredMsg}>
                <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>
                Loading PDF…
              </div>
            )}
            {pdfError && (
              <div style={{ ...centeredMsg, color: "#991b1b" }}>
                <span style={{ fontSize: "1.4rem" }}>⚠️</span>
                {pdfError}
              </div>
            )}
            {blobUrl && !pdfLoading && (
              <iframe src={blobUrl} title="PDF viewer" style={{ width: "100%", height: "100%", border: "none", display: "block" }} />
            )}
          </div>

          {/* ── Notes / Annotation drawer ── */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #e2e8f0", background: "#fafafa" }}>
            {/* Drawer header */}
            <div
              style={{ display: "flex", alignItems: "center", padding: "0.3rem 0.65rem", cursor: "pointer", userSelect: "none", gap: "0.4rem" }}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                📝 Notes ({annotations.length})
              </span>
              <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#94a3b8" }}>{notesOpen ? "▼" : "▲"}</span>
            </div>

            {notesOpen && (
              <div style={{ height: NOTES_H, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Existing annotations */}
                <div style={{ flex: 1, overflowY: "auto", padding: "0 0.65rem 0.4rem" }}>
                  {annotations.length === 0 && (
                    <p style={{ color: "#94a3b8", fontSize: "0.75rem", margin: "0.3rem 0" }}>No notes yet. Add one below.</p>
                  )}
                  {annotations.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        background: "#fffde7",
                        borderLeft: "3px solid #fdd835",
                        padding: "0.35rem 0.6rem",
                        marginBottom: "0.3rem",
                        fontSize: "0.78rem",
                        position: "relative",
                        borderRadius: "0 0.25rem 0.25rem 0",
                      }}
                    >
                      {a.selected_text && (
                        <blockquote style={{ margin: "0 0 0.2rem", fontStyle: "italic", color: "#555", fontSize: "0.75rem" }}>
                          "{a.selected_text}"
                        </blockquote>
                      )}
                      <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{a.comment}</span>
                      <button
                        onClick={() => deleteAnnotation(a.id)}
                        style={{ position: "absolute", top: "0.25rem", right: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "#c5221f", fontSize: "0.75rem", lineHeight: 1 }}
                        title="Delete note"
                      >✕</button>
                    </div>
                  ))}
                </div>

                {/* New note input */}
                <div style={{ padding: "0.35rem 0.65rem 0.5rem", borderTop: "1px solid #e2e8f0", flexShrink: 0 }}>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Add a note about this paper…"
                    rows={2}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      fontSize: "0.8rem",
                      fontFamily: "inherit",
                      border: "1px solid #cbd5e1",
                      borderRadius: "0.25rem",
                      padding: "0.3rem 0.45rem",
                      resize: "none",
                      outline: "none",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submitNote();
                      }
                    }}
                  />
                  {createMut.isError && (
                    <div style={{ fontSize: "0.73rem", color: "#991b1b", marginTop: "0.2rem" }}>
                      Failed to save — {(createMut.error as any)?.response?.data?.detail ?? "please try again."}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.3rem" }}>
                    <button
                      onClick={submitNote}
                      disabled={!noteDraft.trim() || createMut.isPending}
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        padding: "0.22rem 0.75rem",
                        borderRadius: "0.25rem",
                        border: "none",
                        background: noteDraft.trim() ? "#4f46e5" : "#e2e8f0",
                        color: noteDraft.trim() ? "#fff" : "#94a3b8",
                        cursor: noteDraft.trim() ? "pointer" : "default",
                      }}
                    >
                      {createMut.isPending ? "Saving…" : "Save  ⌘↵"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Shared centred-message style ───────────────────────────────────────────
const centeredMsg: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: "0.82rem",
  gap: "0.5rem",
  padding: "1.5rem",
  textAlign: "center",
};
