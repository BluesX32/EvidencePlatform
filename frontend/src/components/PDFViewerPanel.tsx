/**
 * PDFViewerPanel — floating, draggable PDF viewer with:
 *
 *  - pdfjs canvas rendering (page images)
 *  - DIY text layer: spans positioned via pdfjsLib.Util.transform so
 *    text is natively selectable without depending on the fragile
 *    pdfjs TextLayer CSS-variable mechanism
 *  - Select text → "Add Note" popup → annotation stored with page + rects
 *  - Yellow highlight overlay drawn on pages with existing annotations
 *  - Notes drawer: shows all annotations with page badges; clicking jumps
 *    to that page so the user always knows where they annotated
 *
 * Three layout modes: single page | continuous scroll
 * Drag the header to reposition; drag the left edge to resize.
 */
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as pdfjsLib from "pdfjs-dist";
import { ChevronLeft, ChevronRight, StickyNote, BookOpen, AlignJustify } from "lucide-react";
import { fulltextApi, annotationsApi } from "../api/client";
import type {
  FulltextPdfMeta,
  ScreeningNextItem,
  Annotation,
  HighlightRect,
} from "../api/client";

// @ts-ignore
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  item: ScreeningNextItem;
  onClose: () => void;
}

interface SelectionInfo {
  text: string;
  rects: HighlightRect[];
  pageNum: number;
  popupX: number;
  popupY: number;
}

type LayoutMode = "single" | "continuous";

const RENDER_SCALE = 1.5;
const INIT_WIDTH = 560;
const INIT_TOP = 56;
const NOTES_H = 240;

// ── SinglePageView ────────────────────────────────────────────────────────────
// Renders one PDF page: canvas + highlight overlay + selectable DIY text layer.
// The text layer spans are positioned manually using pdfjsLib.Util.transform so
// they align with the canvas rendering without relying on pdfjs TextLayer CSS vars.

interface PageViewProps {
  pdfDoc: any;
  pageNum: number;
  annotations: Annotation[];
  activeNoteId: string | null;
  onTextSelect: (info: SelectionInfo) => void;
  onAnnotationClick: (annId: string, pageNum: number) => void;
}

const SinglePageView = memo(function SinglePageView({
  pdfDoc,
  pageNum,
  annotations,
  activeNoteId,
  onTextSelect,
  onAnnotationClick,
}: PageViewProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const hlCanvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<any>(null);

  // ── Render page + build DIY text layer ──────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    (async () => {
      try {
        const pdfPage = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const vp = pdfPage.getViewport({ scale: RENDER_SCALE });
        vpRef.current = vp;

        const pdfCanvas = pdfCanvasRef.current;
        const hlCanvas = hlCanvasRef.current;
        const textLayerEl = textLayerRef.current;
        if (!pdfCanvas || !hlCanvas || !textLayerEl) return;

        // Size canvases to viewport
        pdfCanvas.width = vp.width;
        pdfCanvas.height = vp.height;
        hlCanvas.width = vp.width;
        hlCanvas.height = vp.height;

        // Render PDF page
        const ctx = pdfCanvas.getContext("2d")!;
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        if (cancelled) return;

        // Build DIY text layer ──────────────────────────────────────────────
        // We do NOT use pdfjsLib.TextLayer because it requires --total-scale-factor
        // CSS variables that collapse the container when not set correctly.
        // Instead we place spans manually using Util.transform, then CSS-scale
        // the whole container to match the displayed canvas size.
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;

        textLayerEl.innerHTML = "";
        // Container is sized in viewport (1.5×) coordinates; a CSS transform
        // scales it down to match the displayed canvas width.
        textLayerEl.style.width = `${vp.width}px`;
        textLayerEl.style.height = `${vp.height}px`;

        const frag = document.createDocumentFragment();
        for (const raw of textContent.items) {
          const item = raw as any;
          if (!("str" in item) || !item.str) continue;

          // Map PDF text matrix → viewport pixel coordinates
          const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
          // Font height = magnitude of the x-basis vector of the combined transform
          const fontHeight = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
          if (fontHeight < 0.5) continue;
          const angle = Math.atan2(tx[1], tx[0]);

          // tx[4], tx[5] = baseline position in viewport pixels
          // CSS top = baseline - font ascent (approx = fontHeight for full em)
          const span = document.createElement("span");
          span.textContent = item.str;
          span.style.cssText = [
            `left:${tx[4]}px`,
            `top:${tx[5] - fontHeight}px`,
            `font-size:${fontHeight}px`,
            "color:transparent",
            "position:absolute",
            "white-space:pre",
            "line-height:1",
            "cursor:text",
            "transform-origin:0% 0%",
            Math.abs(angle) > 0.01 ? `transform:rotate(${angle}rad)` : "",
          ]
            .filter(Boolean)
            .join(";");
          frag.appendChild(span);
        }
        textLayerEl.appendChild(frag);

        // Scale text layer to match the CSS-rendered canvas size
        requestAnimationFrame(() => {
          if (!pdfCanvasRef.current || !textLayerRef.current || !vpRef.current) return;
          const r = pdfCanvasRef.current.getBoundingClientRect();
          if (r.width > 0) {
            const s = r.width / vpRef.current.width;
            textLayerRef.current.style.transform = `scale(${s})`;
          }
        });
      } catch {
        // ignore cancelled or unmounted
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNum]);

  // Keep text layer scale in sync when the panel is resized
  useEffect(() => {
    const canvas = pdfCanvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      if (!vpRef.current || !textLayerRef.current) return;
      const r = canvas.getBoundingClientRect();
      if (r.width > 0) {
        textLayerRef.current.style.transform = `scale(${r.width / vpRef.current.width})`;
      }
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  // Draw annotation highlights on the highlight canvas
  useEffect(() => {
    const canvas = hlCanvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const ann of annotations) {
      if (ann.page_num !== pageNum || !ann.highlight_rects?.length) continue;
      ctx.save();
      ctx.fillStyle =
        ann.id === activeNoteId
          ? "rgba(79,70,229,0.30)"
          : "rgba(255,213,0,0.42)";
      for (const r of ann.highlight_rects) {
        ctx.fillRect(
          r.x * canvas.width,
          r.y * canvas.height,
          r.w * canvas.width,
          r.h * canvas.height
        );
      }
      ctx.restore();
    }
  }, [annotations, pageNum, activeNoteId]);

  // ── Text selection ────────────────────────────────────────────────────────────
  function onMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const range = sel.getRangeAt(0);
    const canvasEl = pdfCanvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const rects: HighlightRect[] = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.left - canvasRect.left) / canvasRect.width,
        y: (r.top - canvasRect.top) / canvasRect.height,
        w: r.width / canvasRect.width,
        h: r.height / canvasRect.height,
      }));

    if (rects.length > 0) {
      onTextSelect({ text, rects, pageNum, popupX: e.clientX, popupY: e.clientY });
    }
  }

  // Click on an existing highlight → activate that annotation
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // ongoing selection, ignore

    const canvasEl = pdfCanvasRef.current;
    if (!canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    const cx = (e.clientX - r.left) / r.width;
    const cy = (e.clientY - r.top) / r.height;

    for (const ann of annotations) {
      if (ann.page_num !== pageNum || !ann.highlight_rects?.length) continue;
      for (const hr of ann.highlight_rects) {
        if (cx >= hr.x && cx <= hr.x + hr.w && cy >= hr.y && cy <= hr.y + hr.h) {
          onAnnotationClick(ann.id, pageNum);
          return;
        }
      }
    }
  }

  return (
    <div style={{ position: "relative" }}>
      {/* PDF rendered to canvas */}
      <canvas
        ref={pdfCanvasRef}
        style={{ display: "block", width: "100%", height: "auto" }}
      />
      {/* Yellow/purple annotation highlights */}
      <canvas
        ref={hlCanvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      {/* Selectable transparent text layer */}
      <div
        ref={textLayerRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          overflow: "hidden",
          transformOrigin: "0 0",
          userSelect: "text",
        }}
        onMouseUp={onMouseUp}
        onClick={onClick}
      />
    </div>
  );
});

// ── PDFViewerPanel ────────────────────────────────────────────────────────────

export function PDFViewerPanel({ projectId, item, onClose }: Props) {
  const qc = useQueryClient();
  const itemKey = item.record_id ?? item.cluster_id;

  // ── PDF metadata ─────────────────────────────────────────────────────────────
  const { data: meta, isLoading: metaLoading } = useQuery<FulltextPdfMeta | null>({
    queryKey: ["fulltext-pdf", projectId, itemKey],
    queryFn: () =>
      fulltextApi
        .getMeta(projectId, { record_id: item.record_id, cluster_id: item.cluster_id })
        .then((r) => r.data),
    enabled: !!itemKey,
    staleTime: 60_000,
  });

  // ── Annotations ──────────────────────────────────────────────────────────────
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

  const [notesOpen, setNotesOpen] = useState(false);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const createMut = useMutation({
    mutationFn: (draft: { comment: string; sel: SelectionInfo | null }) =>
      annotationsApi.create(projectId, {
        record_id: item.record_id ?? null,
        cluster_id: item.cluster_id ?? null,
        selected_text: draft.sel?.text ?? "",
        comment: draft.comment,
        page_num: draft.sel?.pageNum ?? null,
        highlight_rects: draft.sel?.rects ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["annotations", itemKey] });
      setNoteDraft("");
      setSelectionInfo(null);
      window.getSelection()?.removeAllRanges();
      setNotesOpen(true);
    },
  });

  function saveNote() {
    const comment = noteDraft.trim();
    if (!comment) return;
    createMut.mutate({ comment, sel: selectionInfo });
  }

  function deleteAnnotation(annId: string) {
    annotationsApi
      .delete(projectId, annId)
      .then(() => qc.invalidateQueries({ queryKey: ["annotations", itemKey] }));
  }

  // ── Blob URL ─────────────────────────────────────────────────────────────────
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
    return () => {
      cancelled = true;
    };
  }, [projectId, meta?.id]);

  useEffect(
    () => () => {
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
    },
    []
  );

  // ── PDF.js document ───────────────────────────────────────────────────────────
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);

  useEffect(() => {
    if (!blobUrl) return;
    let cancelled = false;
    pdfjsLib
      .getDocument(blobUrl)
      .promise.then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setPageNum(1);
      })
      .catch((err) => {
        if (!cancelled) setPdfError(err?.message || "Failed to parse PDF");
      });
    return () => {
      cancelled = true;
    };
  }, [blobUrl]);

  // ── Layout mode ───────────────────────────────────────────────────────────────
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("single");

  // ── Panel geometry ────────────────────────────────────────────────────────────
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [width, setWidth] = useState(INIT_WIDTH);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (pos === null)
      setPos({ left: window.innerWidth - INIT_WIDTH, top: INIT_TOP });
  }, [pos]);

  const moveStart = useRef<{ mx: number; my: number; left: number; top: number } | null>(null);
  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (
        (e.target as HTMLElement).tagName === "BUTTON" ||
        (e.target as HTMLElement).tagName === "A"
      )
        return;
      e.preventDefault();
      if (!pos) return;
      moveStart.current = { mx: e.clientX, my: e.clientY, left: pos.left, top: pos.top };
      const onMove = (me: MouseEvent) => {
        if (!moveStart.current) return;
        setPos({
          left: Math.max(
            0,
            Math.min(
              window.innerWidth - width,
              moveStart.current.left + me.clientX - moveStart.current.mx
            )
          ),
          top: Math.max(
            0,
            Math.min(
              window.innerHeight - 60,
              moveStart.current.top + me.clientY - moveStart.current.my
            )
          ),
        });
      };
      const onUp = () => {
        moveStart.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pos, width]
  );

  const resizeStart = useRef<{ mx: number; initW: number; initLeft: number } | null>(null);
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!pos) return;
    resizeStart.current = { mx: e.clientX, initW: width, initLeft: pos.left };
    const onMove = (me: MouseEvent) => {
      if (!resizeStart.current) return;
      const delta = resizeStart.current.mx - me.clientX;
      const next = Math.min(1100, Math.max(340, resizeStart.current.initW + delta));
      setWidth(next);
      setPos((p) =>
        p
          ? {
              ...p,
              left:
                resizeStart.current!.initLeft -
                (next - resizeStart.current!.initW),
            }
          : p
      );
    };
    const onUp = () => {
      resizeStart.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (pos === null) return null;

  const filename = meta?.original_filename ?? "";
  const displayName = filename.length > 36 ? filename.slice(0, 33) + "…" : filename;

  // Shared props for every SinglePageView
  const sharedPage = {
    pdfDoc,
    annotations,
    activeNoteId,
    onTextSelect: setSelectionInfo,
    onAnnotationClick: (annId: string, pNum: number) => {
      setActiveNoteId(annId === activeNoteId ? null : annId);
      if (layoutMode === "single") setPageNum(pNum);
      setNotesOpen(true);
    },
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const iconBtn: React.CSSProperties = {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    padding: "0.1rem 0.3rem",
    borderRadius: "0.25rem",
    lineHeight: 1,
    fontSize: "0.85rem",
  };

  const toolBtn = (active: boolean): React.CSSProperties => ({
    padding: "0.18rem 0.5rem",
    borderRadius: "0.25rem",
    border: `1.5px solid ${active ? "#4f46e5" : "#cbd5e1"}`,
    background: active ? "#eef2ff" : "#fff",
    color: active ? "#4f46e5" : "#475569",
    cursor: "pointer",
    fontSize: "0.73rem",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "0.22rem",
  });

  return (
    <div
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: `${width}px`,
        height: minimized ? "auto" : `calc(100vh - ${pos.top}px)`,
        maxHeight: minimized ? undefined : `calc(100vh - ${pos.top}px)`,
        zIndex: 300,
        background: "#fff",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        borderRadius: "0.5rem",
        border: "1px solid #e2e8f0",
        overflow: "hidden",
      }}
      aria-label="PDF viewer panel"
    >
      {/* Left-edge resize handle */}
      {!minimized && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 5,
            cursor: "ew-resize",
            zIndex: 1,
          }}
          onMouseDown={onResizeMouseDown}
        />
      )}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        style={{
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
        }}
        onMouseDown={onHeaderMouseDown}
      >
        <span style={{ fontSize: "0.9rem", pointerEvents: "none" }}>📄</span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
          title={filename || "PDF Viewer"}
        >
          {displayName || "PDF Viewer"}
        </span>
        {blobUrl && !minimized && (
          <a
            href={blobUrl}
            download={filename}
            style={{ ...iconBtn, textDecoration: "none" }}
            title="Download PDF"
          >
            ⬇
          </a>
        )}
        <button
          style={iconBtn}
          title={minimized ? "Expand" : "Minimise"}
          onClick={() => setMinimized((v) => !v)}
        >
          {minimized ? "▲" : "▼"}
        </button>
        <button style={iconBtn} title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {!minimized && (
        <>
          {/* ── Toolbar ─────────────────────────────────────────────────────── */}
          {pdfDoc && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.3rem 0.6rem",
                borderBottom: "1px solid #e2e8f0",
                background: "#f8fafc",
                flexShrink: 0,
                flexWrap: "wrap",
              }}
            >
              {/* Layout toggle */}
              <button
                style={toolBtn(layoutMode === "single")}
                onClick={() => setLayoutMode("single")}
                title="Single page"
              >
                <BookOpen size={13} /> Single
              </button>
              <button
                style={toolBtn(layoutMode === "continuous")}
                onClick={() => setLayoutMode("continuous")}
                title="Continuous scroll"
              >
                <AlignJustify size={13} /> Scroll
              </button>

              {/* Page navigation (single mode only) */}
              {layoutMode === "single" && (
                <>
                  <div
                    style={{
                      width: 1,
                      height: 20,
                      background: "#e2e8f0",
                      margin: "0 0.1rem",
                    }}
                  />
                  <button
                    style={{ ...toolBtn(false), padding: "0.18rem 0.4rem" }}
                    disabled={pageNum <= 1}
                    onClick={() => setPageNum((p) => p - 1)}
                    title="Previous page"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span
                    style={{
                      fontSize: "0.73rem",
                      color: "#475569",
                      minWidth: "4rem",
                      textAlign: "center",
                    }}
                  >
                    {pageNum} / {numPages}
                  </span>
                  <button
                    style={{ ...toolBtn(false), padding: "0.18rem 0.4rem" }}
                    disabled={pageNum >= numPages}
                    onClick={() => setPageNum((p) => p + 1)}
                    title="Next page"
                  >
                    <ChevronRight size={14} />
                  </button>
                </>
              )}

              {/* Hint */}
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: "0.68rem",
                  color: "#94a3b8",
                  fontStyle: "italic",
                }}
              >
                Drag to select text
              </span>
            </div>
          )}

          {/* ── PDF canvas area ──────────────────────────────────────────────── */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              position: "relative",
              background: "#525659",
              minHeight: 0,
            }}
          >
            {!meta && !pdfLoading && !metaLoading && (
              <div style={centeredMsg}>
                <span style={{ fontSize: "2rem" }}>📂</span>
                No PDF uploaded yet.
                <br />
                Use the Upload PDF button to attach a file.
              </div>
            )}
            {pdfLoading && (
              <div style={centeredMsg}>
                <span>⏳</span> Loading…
              </div>
            )}
            {pdfError && (
              <div style={{ ...centeredMsg, color: "#fca5a5" }}>
                <span>⚠️</span> {pdfError}
              </div>
            )}

            {pdfDoc && layoutMode === "single" && (
              <SinglePageView {...sharedPage} pageNum={pageNum} />
            )}

            {pdfDoc && layoutMode === "continuous" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 4,
                }}
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                  <SinglePageView key={p} {...sharedPage} pageNum={p} />
                ))}
              </div>
            )}
          </div>

          {/* ── Text selection popup ─────────────────────────────────────────── */}
          {selectionInfo && (
            <div
              style={{
                position: "fixed",
                left: Math.min(selectionInfo.popupX, window.innerWidth - 280),
                top: Math.max(8, selectionInfo.popupY - 130),
                width: 270,
                background: "#fff",
                border: "1.5px solid #4f46e5",
                borderRadius: "0.5rem",
                boxShadow: "0 4px 20px rgba(0,0,0,0.18)",
                zIndex: 500,
                padding: "0.6rem 0.75rem 0.55rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
              }}
            >
              {/* Selected text preview */}
              <div
                style={{
                  fontSize: "0.72rem",
                  color: "#475569",
                  background: "#f1f5f9",
                  borderRadius: "0.25rem",
                  padding: "0.3rem 0.45rem",
                  fontStyle: "italic",
                  lineHeight: 1.4,
                  maxHeight: 56,
                  overflow: "hidden",
                }}
              >
                "
                {selectionInfo.text.length > 100
                  ? selectionInfo.text.slice(0, 100) + "…"
                  : selectionInfo.text}
                "
              </div>
              {/* Note textarea */}
              <textarea
                autoFocus
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Add a note about this passage… (⌘↵ to save)"
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
                    saveNote();
                  }
                  if (e.key === "Escape") {
                    setSelectionInfo(null);
                    setNoteDraft("");
                    window.getSelection()?.removeAllRanges();
                  }
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.4rem",
                }}
              >
                <button
                  onClick={() => {
                    setSelectionInfo(null);
                    setNoteDraft("");
                    window.getSelection()?.removeAllRanges();
                  }}
                  style={{
                    fontSize: "0.73rem",
                    padding: "0.22rem 0.6rem",
                    borderRadius: "0.25rem",
                    border: "1px solid #e2e8f0",
                    background: "#fff",
                    cursor: "pointer",
                    color: "#64748b",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveNote}
                  disabled={!noteDraft.trim() || createMut.isPending}
                  style={{
                    fontSize: "0.73rem",
                    fontWeight: 600,
                    padding: "0.22rem 0.75rem",
                    borderRadius: "0.25rem",
                    border: "none",
                    background: noteDraft.trim() ? "#4f46e5" : "#e2e8f0",
                    color: noteDraft.trim() ? "#fff" : "#94a3b8",
                    cursor: noteDraft.trim() ? "pointer" : "default",
                  }}
                >
                  {createMut.isPending ? "Saving…" : "Save note"}
                </button>
              </div>
            </div>
          )}

          {/* ── Notes drawer ─────────────────────────────────────────────────── */}
          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid #e2e8f0",
              background: "#fafafa",
            }}
          >
            {/* Drawer header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "0.3rem 0.65rem",
                cursor: "pointer",
                userSelect: "none",
                gap: "0.4rem",
              }}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <StickyNote size={12} style={{ color: "#64748b", flexShrink: 0 }} />
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                }}
              >
                Notes ({annotations.length})
              </span>
              {/* Page badges for quick overview */}
              {annotations.length > 0 && (
                <span style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {[...new Set(annotations.map((a) => a.page_num).filter(Boolean))]
                    .sort((a, b) => (a ?? 0) - (b ?? 0))
                    .slice(0, 6)
                    .map((p) => (
                      <span
                        key={p}
                        style={{
                          fontSize: "0.62rem",
                          background: "#eef2ff",
                          color: "#4f46e5",
                          borderRadius: "0.2rem",
                          padding: "0 0.3rem",
                          fontWeight: 600,
                        }}
                      >
                        p.{p}
                      </span>
                    ))}
                </span>
              )}
              <span
                style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#94a3b8" }}
              >
                {notesOpen ? "▼" : "▲"}
              </span>
            </div>

            {notesOpen && (
              <div
                style={{
                  height: NOTES_H,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                {/* Annotation list */}
                <div
                  style={{ flex: 1, overflowY: "auto", padding: "0 0.65rem 0.4rem" }}
                >
                  {annotations.length === 0 && (
                    <p
                      style={{
                        color: "#94a3b8",
                        fontSize: "0.75rem",
                        margin: "0.4rem 0",
                      }}
                    >
                      No notes yet. Select text in the PDF and add a note.
                    </p>
                  )}
                  {annotations.map((a) => (
                    <div
                      key={a.id}
                      onClick={() => {
                        setActiveNoteId(a.id === activeNoteId ? null : a.id);
                        if (a.page_num != null && layoutMode === "single")
                          setPageNum(a.page_num);
                      }}
                      style={{
                        background:
                          a.id === activeNoteId ? "#eef2ff" : "#fffde7",
                        borderLeft: `3px solid ${
                          a.id === activeNoteId ? "#4f46e5" : "#fdd835"
                        }`,
                        padding: "0.35rem 0.6rem",
                        marginBottom: "0.3rem",
                        fontSize: "0.78rem",
                        position: "relative",
                        borderRadius: "0 0.25rem 0.25rem 0",
                        cursor: "pointer",
                      }}
                    >
                      {/* Page badge */}
                      {a.page_num != null && (
                        <span
                          style={{
                            fontSize: "0.65rem",
                            color: "#4f46e5",
                            fontWeight: 700,
                            marginBottom: "0.18rem",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.25rem",
                          }}
                        >
                          p.{a.page_num}
                          {layoutMode === "single" && a.page_num !== pageNum && (
                            <span style={{ opacity: 0.6, fontWeight: 400 }}>
                              — click to jump
                            </span>
                          )}
                        </span>
                      )}
                      {/* Quoted text */}
                      {a.selected_text && (
                        <blockquote
                          style={{
                            margin: "0.1rem 0 0.25rem",
                            fontStyle: "italic",
                            color: "#475569",
                            fontSize: "0.74rem",
                            borderLeft: "none",
                            paddingLeft: 0,
                            lineHeight: 1.4,
                          }}
                        >
                          "
                          {a.selected_text.length > 140
                            ? a.selected_text.slice(0, 140) + "…"
                            : a.selected_text}
                          "
                        </blockquote>
                      )}
                      {/* Note comment */}
                      {a.comment && (
                        <span
                          style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, display: "block" }}
                        >
                          {a.comment}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAnnotation(a.id);
                          if (activeNoteId === a.id) setActiveNoteId(null);
                        }}
                        style={{
                          position: "absolute",
                          top: "0.25rem",
                          right: "0.25rem",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "#c5221f",
                          fontSize: "0.75rem",
                          lineHeight: 1,
                        }}
                        title="Delete note"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Quick note without selection */}
                <div
                  style={{
                    padding: "0.35rem 0.65rem 0.5rem",
                    borderTop: "1px solid #e2e8f0",
                    flexShrink: 0,
                  }}
                >
                  <textarea
                    value={selectionInfo ? "" : noteDraft}
                    onChange={(e) => {
                      if (!selectionInfo) setNoteDraft(e.target.value);
                    }}
                    placeholder="Add a general note… (⌘↵ to save)"
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
                      background: selectionInfo ? "#f8fafc" : "#fff",
                      color: selectionInfo ? "#94a3b8" : undefined,
                    }}
                    disabled={!!selectionInfo}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        if (!selectionInfo) saveNote();
                      }
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: "0.3rem",
                    }}
                  >
                    {selectionInfo ? (
                      <span style={{ fontSize: "0.7rem", color: "#6366f1", fontStyle: "italic" }}>
                        Text selected — use the popup above to add a note
                      </span>
                    ) : (
                      <span />
                    )}
                    <button
                      onClick={() => { if (!selectionInfo) saveNote(); }}
                      disabled={!!selectionInfo || !noteDraft.trim() || createMut.isPending}
                      style={{
                        fontSize: "0.73rem",
                        fontWeight: 600,
                        padding: "0.22rem 0.75rem",
                        borderRadius: "0.25rem",
                        border: "none",
                        background:
                          !selectionInfo && noteDraft.trim() ? "#4f46e5" : "#e2e8f0",
                        color:
                          !selectionInfo && noteDraft.trim() ? "#fff" : "#94a3b8",
                        cursor:
                          !selectionInfo && noteDraft.trim() ? "pointer" : "default",
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

// ── Shared style ──────────────────────────────────────────────────────────────

const centeredMsg: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  color: "#94a3b8",
  fontSize: "0.82rem",
  gap: "0.5rem",
  padding: "1.5rem",
  textAlign: "center",
};
