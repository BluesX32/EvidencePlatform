/**
 * PDFViewerPanel — floating, draggable PDF viewer with:
 *  - PDF.js canvas rendering (so we can overlay a drawing layer)
 *  - Freehand drawing that persists to the database via PATCH /fulltext/{id}/drawing
 *  - Notes drawer backed by the existing annotationsApi
 *
 * Drag the header to reposition; drag the left edge to resize.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as pdfjsLib from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Pen, Eraser, Trash2, StickyNote } from "lucide-react";
import { fulltextApi, annotationsApi } from "../api/client";
import type { FulltextPdfMeta, ScreeningNextItem, Annotation, DrawingStroke } from "../api/client";

// Point pdfjs at its worker (Vite resolves ?url imports)
// @ts-ignore
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface Props {
  projectId: string;
  item: ScreeningNextItem;
  onClose: () => void;
}

type Tool = "pen" | "eraser";

const INIT_WIDTH = 520;
const INIT_HEIGHT_OFFSET = 56;
const INIT_RIGHT = 0;
const NOTES_H = 220;
const RENDER_SCALE = 1.5;
const SAVE_DEBOUNCE_MS = 1500;

type DrawingData = Record<string, DrawingStroke[]>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderStrokesToCtx(ctx: CanvasRenderingContext2D, strokes: DrawingStroke[]) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    ctx.save();
    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = s.color;
    }
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i][0], s.points[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PDFViewerPanel({ projectId, item, onClose }: Props) {
  const qc = useQueryClient();
  const itemKey = item.record_id ?? item.cluster_id;

  // ── PDF metadata ────────────────────────────────────────────────────────────
  const { data: meta } = useQuery<FulltextPdfMeta | null>({
    queryKey: ["fulltext-pdf", projectId, itemKey],
    queryFn: () =>
      fulltextApi
        .getMeta(projectId, { record_id: item.record_id, cluster_id: item.cluster_id })
        .then((r) => r.data),
    enabled: !!itemKey,
    staleTime: 60_000,
  });

  // ── Annotations ─────────────────────────────────────────────────────────────
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
    annotationsApi
      .delete(projectId, annId)
      .then(() => qc.invalidateQueries({ queryKey: ["annotations", itemKey] }));
  }

  // ── Blob URL ────────────────────────────────────────────────────────────────
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

  // ── PDF.js doc ───────────────────────────────────────────────────────────────
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageRendering, setPageRendering] = useState(false);

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

  // ── Drawing state ────────────────────────────────────────────────────────────
  const [drawingData, setDrawingData] = useState<DrawingData>({});
  const [tool, setTool] = useState<Tool>("pen");
  const [penColor, setPenColor] = useState("#e53e3e");
  const [penWidth, setPenWidth] = useState(3);

  // Load drawing data from server when meta arrives
  useEffect(() => {
    if (meta?.drawing_data) {
      setDrawingData(meta.drawing_data as DrawingData);
    } else {
      setDrawingData({});
    }
  }, [meta?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save drawing (debounced) ─────────────────────────────────────────────────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawingDataRef = useRef<DrawingData>(drawingData);
  drawingDataRef.current = drawingData;

  const saveMut = useMutation({
    mutationFn: ({ pdfId, data }: { pdfId: string; data: DrawingData }) =>
      fulltextApi.saveDrawing(projectId, pdfId, data),
    onSuccess: (res) => {
      qc.setQueryData(["fulltext-pdf", projectId, itemKey], res.data);
    },
  });

  function scheduleSave() {
    if (!meta?.id) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const pdfId = meta.id;
    saveTimerRef.current = setTimeout(() => {
      saveMut.mutate({ pdfId, data: drawingDataRef.current });
    }, SAVE_DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    []
  );

  // ── Canvas refs ──────────────────────────────────────────────────────────────
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const currentPointsRef = useRef<[number, number][]>([]);

  // ── Render page ──────────────────────────────────────────────────────────────
  const renderPage = useCallback(
    (doc: any, page: number, strokes: DrawingStroke[]) => {
      if (!pdfCanvasRef.current || !drawCanvasRef.current) return;
      setPageRendering(true);
      doc
        .getPage(page)
        .then((pdfPage: any) => {
          const vp = pdfPage.getViewport({ scale: RENDER_SCALE });
          const pdfCanvas = pdfCanvasRef.current!;
          pdfCanvas.width = vp.width;
          pdfCanvas.height = vp.height;
          const drawCanvas = drawCanvasRef.current!;
          drawCanvas.width = vp.width;
          drawCanvas.height = vp.height;

          const ctx = pdfCanvas.getContext("2d")!;
          pdfPage
            .render({ canvasContext: ctx, viewport: vp })
            .promise.then(() => {
              setPageRendering(false);
              const dCtx = drawCanvas.getContext("2d")!;
              renderStrokesToCtx(dCtx, strokes);
            })
            .catch(() => setPageRendering(false));
        })
        .catch(() => setPageRendering(false));
    },
    []
  );

  useEffect(() => {
    if (!pdfDoc) return;
    const strokes = drawingData[String(pageNum)] ?? [];
    renderPage(pdfDoc, pageNum, strokes);
  }, [pdfDoc, pageNum, renderPage]); // drawingData intentionally omitted — we re-render on page change only

  // Re-render drawing layer when strokes for current page change (without re-rendering PDF)
  useEffect(() => {
    if (!drawCanvasRef.current) return;
    const dCtx = drawCanvasRef.current.getContext("2d");
    if (!dCtx) return;
    const strokes = drawingData[String(pageNum)] ?? [];
    renderStrokesToCtx(dCtx, strokes);
  }, [drawingData, pageNum]);

  // ── Mouse drawing events ──────────────────────────────────────────────────────
  function getCanvasXY(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const rect = drawCanvasRef.current!.getBoundingClientRect();
    const scaleX = drawCanvasRef.current!.width / rect.width;
    const scaleY = drawCanvasRef.current!.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  function onDrawMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    isDrawingRef.current = true;
    currentPointsRef.current = [getCanvasXY(e)];
  }

  function onDrawMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const pt = getCanvasXY(e);
    currentPointsRef.current.push(pt);

    // Live preview on draw canvas
    const dCtx = drawCanvasRef.current?.getContext("2d");
    if (!dCtx) return;
    const pts = currentPointsRef.current;
    if (pts.length < 2) return;
    dCtx.save();
    if (tool === "eraser") {
      dCtx.globalCompositeOperation = "destination-out";
      dCtx.strokeStyle = "rgba(0,0,0,1)";
      dCtx.lineWidth = penWidth * 5;
    } else {
      dCtx.globalCompositeOperation = "source-over";
      dCtx.strokeStyle = penColor;
      dCtx.lineWidth = penWidth;
    }
    dCtx.lineCap = "round";
    dCtx.lineJoin = "round";
    dCtx.beginPath();
    dCtx.moveTo(pts[pts.length - 2][0], pts[pts.length - 2][1]);
    dCtx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    dCtx.stroke();
    dCtx.restore();
  }

  function onDrawMouseUp() {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const pts = currentPointsRef.current;
    if (pts.length < 2) {
      currentPointsRef.current = [];
      return;
    }
    const newStroke: DrawingStroke = {
      color: tool === "eraser" ? "#000000" : penColor,
      width: tool === "eraser" ? penWidth * 5 : penWidth,
      points: [...pts],
      tool,
    };
    currentPointsRef.current = [];
    const key = String(pageNum);
    setDrawingData((prev) => {
      const updated = { ...prev, [key]: [...(prev[key] ?? []), newStroke] };
      return updated;
    });
    scheduleSave();
  }

  function clearCurrentPage() {
    const key = String(pageNum);
    setDrawingData((prev) => {
      const updated = { ...prev, [key]: [] };
      return updated;
    });
    scheduleSave();
  }

  // ── Panel position & size ────────────────────────────────────────────────────
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [width, setWidth] = useState(INIT_WIDTH);
  const [minimized, setMinimized] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pos === null) {
      setPos({
        left: window.innerWidth - INIT_WIDTH - INIT_RIGHT,
        top: INIT_HEIGHT_OFFSET,
      });
    }
  }, [pos]);

  // Header drag
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
        const dx = me.clientX - moveStart.current.mx;
        const dy = me.clientY - moveStart.current.my;
        setPos({
          left: Math.max(0, Math.min(window.innerWidth - width, moveStart.current.left + dx)),
          top: Math.max(0, Math.min(window.innerHeight - 60, moveStart.current.top + dy)),
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

  // Left-edge resize
  const resizeStart = useRef<{ mx: number; initW: number; initLeft: number } | null>(null);
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!pos) return;
    resizeStart.current = { mx: e.clientX, initW: width, initLeft: pos.left };
    const onMove = (me: MouseEvent) => {
      if (!resizeStart.current) return;
      const delta = resizeStart.current.mx - me.clientX;
      const next = Math.min(900, Math.max(320, resizeStart.current.initW + delta));
      setWidth(next);
      setPos((p) =>
        p
          ? { ...p, left: resizeStart.current!.initLeft - (next - resizeStart.current!.initW) }
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
  const displayName = filename.length > 32 ? filename.slice(0, 29) + "…" : filename;

  // ── Styles ───────────────────────────────────────────────────────────────────
  const panelStyle: React.CSSProperties = {
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

  const toolbarStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.3rem 0.6rem",
    borderBottom: "1px solid #e2e8f0",
    background: "#f8fafc",
    flexShrink: 0,
    flexWrap: "wrap",
  };

  const toolBtn = (active: boolean): React.CSSProperties => ({
    padding: "0.2rem 0.55rem",
    borderRadius: "0.25rem",
    border: `1.5px solid ${active ? "#4f46e5" : "#cbd5e1"}`,
    background: active ? "#eef2ff" : "#fff",
    color: active ? "#4f46e5" : "#475569",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  });

  const savingLabel = saveMut.isPending ? "Saving…" : saveMut.isError ? "⚠ Save failed" : "";

  return (
    <div ref={panelRef} style={panelStyle} aria-label="PDF viewer panel">
      {!minimized && <div style={dragHandle} onMouseDown={onResizeMouseDown} />}

      {/* Header */}
      <div style={headerStyle} onMouseDown={onHeaderMouseDown}>
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
        {savingLabel && (
          <span style={{ fontSize: "0.7rem", opacity: 0.85, pointerEvents: "none" }}>
            {savingLabel}
          </span>
        )}
        <button style={iconBtn} title={minimized ? "Expand" : "Minimise"} onClick={() => setMinimized((v) => !v)}>
          {minimized ? "▲" : "▼"}
        </button>
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
        <button style={iconBtn} title="Close viewer" onClick={onClose}>
          ✕
        </button>
      </div>

      {!minimized && (
        <>
          {/* Toolbar */}
          {pdfDoc && (
            <div style={toolbarStyle}>
              {/* ── Page navigation ── */}
              <button
                style={toolBtn(false)}
                disabled={pageNum <= 1 || pageRendering}
                onClick={() => setPageNum((p) => p - 1)}
                title="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span style={{ fontSize: "0.75rem", color: "#475569", minWidth: "3.5rem", textAlign: "center" }}>
                {pageNum} / {numPages}
              </span>
              <button
                style={toolBtn(false)}
                disabled={pageNum >= numPages || pageRendering}
                onClick={() => setPageNum((p) => p + 1)}
                title="Next page"
              >
                <ChevronRight size={14} />
              </button>

              <div style={{ width: "1px", height: "20px", background: "#e2e8f0", margin: "0 0.15rem" }} />

              {/* ── Drawing tools ── */}
              <button
                style={{ ...toolBtn(tool === "pen"), display: "flex", alignItems: "center", gap: "0.25rem" }}
                onClick={() => setTool("pen")}
                title="Pen — draw on PDF"
              >
                <Pen size={13} /> Pen
              </button>
              <button
                style={{ ...toolBtn(tool === "eraser"), display: "flex", alignItems: "center", gap: "0.25rem" }}
                onClick={() => setTool("eraser")}
                title="Eraser — remove drawings"
              >
                <Eraser size={13} /> Eraser
              </button>

              <div style={{ width: "1px", height: "20px", background: "#e2e8f0", margin: "0 0.15rem" }} />

              {/* ── Color + width (pen only) ── */}
              <input
                type="color"
                value={penColor}
                onChange={(e) => setPenColor(e.target.value)}
                title="Pen color"
                disabled={tool === "eraser"}
                style={{
                  width: "26px", height: "26px",
                  border: "1px solid #cbd5e1", borderRadius: "0.2rem",
                  padding: "1px", cursor: tool === "eraser" ? "default" : "pointer",
                  opacity: tool === "eraser" ? 0.4 : 1,
                }}
              />
              <select
                value={penWidth}
                onChange={(e) => setPenWidth(Number(e.target.value))}
                title={tool === "eraser" ? "Eraser size" : "Stroke width"}
                style={{ fontSize: "0.72rem", border: "1px solid #cbd5e1", borderRadius: "0.2rem", padding: "0.15rem 0.25rem", background: "#fff" }}
              >
                <option value={1}>Thin</option>
                <option value={3}>Medium</option>
                <option value={6}>Thick</option>
              </select>

              {/* ── Clear page ── */}
              <button
                style={{ ...toolBtn(false), marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.25rem", color: "#991b1b", borderColor: "#fca5a5" }}
                onClick={clearCurrentPage}
                title="Clear all drawings on this page"
              >
                <Trash2 size={12} /> Clear
              </button>
            </div>
          )}

          {/* PDF + drawing area */}
          <div style={{ flex: 1, overflow: "auto", position: "relative", background: "#e2e8f0", minHeight: 0 }}>
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

            {/* Canvas stack */}
            {meta && (
              <div style={{ position: "relative", display: "inline-block", minWidth: "100%" }}>
                {/* PDF canvas */}
                <canvas
                  ref={pdfCanvasRef}
                  style={{ display: "block", maxWidth: "100%" }}
                />
                {/* Drawing canvas — overlaid, transparent background */}
                <canvas
                  ref={drawCanvasRef}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    cursor: tool === "eraser" ? "crosshair" : "crosshair",
                    maxWidth: "100%",
                    touchAction: "none",
                  }}
                  onMouseDown={onDrawMouseDown}
                  onMouseMove={onDrawMouseMove}
                  onMouseUp={onDrawMouseUp}
                  onMouseLeave={onDrawMouseUp}
                />
              </div>
            )}
          </div>

          {/* Notes drawer */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #e2e8f0", background: "#fafafa" }}>
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
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                }}
              >
                <StickyNote size={12} style={{ flexShrink: 0 }} /> Notes ({annotations.length})
              </span>
              <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#94a3b8" }}>
                {notesOpen ? "▼" : "▲"}
              </span>
            </div>

            {notesOpen && (
              <div style={{ height: NOTES_H, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ flex: 1, overflowY: "auto", padding: "0 0.65rem 0.4rem" }}>
                  {annotations.length === 0 && (
                    <p style={{ color: "#94a3b8", fontSize: "0.75rem", margin: "0.3rem 0" }}>
                      No notes yet. Add one below.
                    </p>
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
                        <blockquote
                          style={{
                            margin: "0 0 0.2rem",
                            fontStyle: "italic",
                            color: "#555",
                            fontSize: "0.75rem",
                          }}
                        >
                          "{a.selected_text}"
                        </blockquote>
                      )}
                      <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{a.comment}</span>
                      <button
                        onClick={() => deleteAnnotation(a.id)}
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

                <div
                  style={{
                    padding: "0.35rem 0.65rem 0.5rem",
                    borderTop: "1px solid #e2e8f0",
                    flexShrink: 0,
                  }}
                >
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
                      Failed to save —{" "}
                      {(createMut.error as any)?.response?.data?.detail ?? "please try again."}
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

// ── Centred message style ─────────────────────────────────────────────────────
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
