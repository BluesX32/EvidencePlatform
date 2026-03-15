/**
 * PDFViewerPanel — floating, draggable PDF viewer with:
 *  - PDF.js canvas rendering + proper text layer (text selection works)
 *  - Three layout modes: single page, two pages side-by-side, continuous scroll
 *  - Freehand drawing persisted via PATCH /fulltext/{id}/drawing
 *  - Notes drawer backed by annotationsApi
 */
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as pdfjsLib from "pdfjs-dist";
import {
  ChevronLeft,
  ChevronRight,
  Pen,
  Eraser,
  Trash2,
  StickyNote,
  MousePointer2,
  BookOpen,
  Columns2,
  AlignJustify,
} from "lucide-react";
import { fulltextApi, annotationsApi } from "../api/client";
import type {
  FulltextPdfMeta,
  ScreeningNextItem,
  Annotation,
  DrawingStroke,
  HighlightRect,
} from "../api/client";

// @ts-ignore
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// ── Types & constants ─────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  item: ScreeningNextItem;
  onClose: () => void;
}

type Tool = "pen" | "eraser" | "select";
type LayoutMode = "single" | "two" | "continuous";

interface SelectionInfo {
  text: string;
  rects: HighlightRect[];
  pageNum: number;
  popupX: number;
  popupY: number;
}

type DrawingData = Record<string, DrawingStroke[]>;

const INIT_WIDTH = 520;
const INIT_HEIGHT_OFFSET = 56;
const INIT_RIGHT = 0;
const NOTES_H = 220;
const RENDER_SCALE = 1.5;
const SAVE_DEBOUNCE_MS = 1500;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── SinglePageView ────────────────────────────────────────────────────────────
// Renders a single PDF page: PDF canvas + highlight canvas + text layer + draw canvas.
// Handles its own rendering, text selection, and drawing.

interface PageViewProps {
  pdfDoc: any;
  pageNum: number;
  drawingStrokes: DrawingStroke[];
  onNewStroke: (pageNum: number, stroke: DrawingStroke) => void;
  tool: Tool;
  penColor: string;
  penWidth: number;
  annotations: Annotation[];
  activeNoteId: string | null;
  onTextSelect: (info: SelectionInfo) => void;
  onAnnotationClick: (annId: string, pageNum: number) => void;
}

const SinglePageView = memo(function SinglePageView({
  pdfDoc,
  pageNum,
  drawingStrokes,
  onNewStroke,
  tool,
  penColor,
  penWidth,
  annotations,
  activeNoteId,
  onTextSelect,
  onAnnotationClick,
}: PageViewProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<any>(null);
  const isDrawingRef = useRef(false);
  const currentPointsRef = useRef<[number, number][]>([]);
  // Keep latest props in refs to avoid stale closures in event handlers
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const penColorRef = useRef(penColor);
  penColorRef.current = penColor;
  const penWidthRef = useRef(penWidth);
  penWidthRef.current = penWidth;
  const drawingStrokesRef = useRef(drawingStrokes);
  drawingStrokesRef.current = drawingStrokes;
  const onNewStrokeRef = useRef(onNewStroke);
  onNewStrokeRef.current = onNewStroke;
  const onTextSelectRef = useRef(onTextSelect);
  onTextSelectRef.current = onTextSelect;
  const onAnnotationClickRef = useRef(onAnnotationClick);
  onAnnotationClickRef.current = onAnnotationClick;
  const pageNumRef = useRef(pageNum);
  pageNumRef.current = pageNum;

  // ── Render PDF + text layer ──────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    let textLayerTask: any = null;

    (async () => {
      try {
        const pdfPage = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const vp = pdfPage.getViewport({ scale: RENDER_SCALE });
        vpRef.current = vp;

        // Size all canvases to match viewport
        const pdfCanvas = pdfCanvasRef.current;
        const drawCanvas = drawCanvasRef.current;
        const hlCanvas = highlightCanvasRef.current;
        const textLayerEl = textLayerRef.current;
        if (!pdfCanvas || !drawCanvas || !textLayerEl) return;

        pdfCanvas.width = vp.width;
        pdfCanvas.height = vp.height;
        drawCanvas.width = vp.width;
        drawCanvas.height = vp.height;
        if (hlCanvas) {
          hlCanvas.width = vp.width;
          hlCanvas.height = vp.height;
        }

        // Render PDF page to canvas
        const ctx = pdfCanvas.getContext("2d")!;
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        if (cancelled) return;

        // Render existing drawing strokes
        const dCtx = drawCanvas.getContext("2d")!;
        renderStrokesToCtx(dCtx, drawingStrokesRef.current);

        // Render text layer using pdfjs-dist 5.x TextLayer class.
        // IMPORTANT: pdfjs TextLayer.render() internally calls setLayerDimensions()
        // which sets container width/height to `calc(var(--total-scale-factor) * pageWidth)`.
        // Without --total-scale-factor the container collapses to 0×0 and overflow:hidden
        // clips every span, making selection impossible.
        textLayerEl.innerHTML = "";
        // Set --total-scale-factor so pdfjs can size the container and spans correctly.
        textLayerEl.style.setProperty("--total-scale-factor", String(RENDER_SCALE));

        try {
          const TL = pdfjsLib.TextLayer;
          textLayerTask = new TL({
            textContentSource: pdfPage.streamTextContent(),
            container: textLayerEl,
            viewport: vp,
          });
          await textLayerTask.render();
        } catch (err) {
          console.warn("TextLayer render failed:", err);
        }

        if (cancelled) return;

        // Apply CSS scale so text layer spans align with the CSS-scaled canvas
        requestAnimationFrame(() => {
          if (!pdfCanvasRef.current || !textLayerRef.current || !vpRef.current) return;
          const rect = pdfCanvasRef.current.getBoundingClientRect();
          if (rect.width > 0 && vpRef.current.width > 0) {
            const s = rect.width / vpRef.current.width;
            textLayerRef.current.style.transform = `scale(${s})`;
            textLayerRef.current.style.transformOrigin = "top left";
          }
        });
      } catch {
        // ignore render errors (cancelled or PDF unloaded)
      }
    })();

    return () => {
      cancelled = true;
      try { textLayerTask?.cancel(); } catch {}
    };
  }, [pdfDoc, pageNum]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Re-render drawing layer when strokes change ──────────────────────────────
  useEffect(() => {
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return;
    const dCtx = drawCanvas.getContext("2d");
    if (!dCtx) return;
    renderStrokesToCtx(dCtx, drawingStrokes);
  }, [drawingStrokes]);

  // ── Update text layer transform on canvas resize ────────────────────────────
  useEffect(() => {
    const canvas = pdfCanvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      if (!vpRef.current || !textLayerRef.current) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && vpRef.current.width > 0) {
        const s = rect.width / vpRef.current.width;
        textLayerRef.current.style.transform = `scale(${s})`;
        textLayerRef.current.style.transformOrigin = "top left";
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // ── Highlight annotation rects ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = highlightCanvasRef.current;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pageAnns = annotations.filter(
      (a) => a.page_num === pageNum && a.highlight_rects?.length
    );
    for (const ann of pageAnns) {
      ctx.save();
      ctx.fillStyle =
        ann.id === activeNoteId
          ? "rgba(79, 70, 229, 0.28)"
          : "rgba(255, 213, 0, 0.38)";
      for (const r of ann.highlight_rects!) {
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
  function onTextLayerMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const clientRects = Array.from(range.getClientRects());
    const canvasEl = pdfCanvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const rects: HighlightRect[] = clientRects
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.left - canvasRect.left) / canvasRect.width,
        y: (r.top - canvasRect.top) / canvasRect.height,
        w: r.width / canvasRect.width,
        h: r.height / canvasRect.height,
      }));
    onTextSelectRef.current({
      text,
      rects,
      pageNum: pageNumRef.current,
      popupX: e.clientX,
      popupY: e.clientY,
    });
  }

  function onTextLayerClick(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const canvasEl = pdfCanvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const cx = (e.clientX - canvasRect.left) / canvasRect.width;
    const cy = (e.clientY - canvasRect.top) / canvasRect.height;
    const pageAnns = annotations.filter(
      (a) => a.page_num === pageNumRef.current && a.highlight_rects?.length
    );
    for (const ann of pageAnns) {
      for (const r of ann.highlight_rects!) {
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          onAnnotationClickRef.current(ann.id, pageNumRef.current);
          return;
        }
      }
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────
  function getCanvasXY(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const el = drawCanvasRef.current!;
    const rect = el.getBoundingClientRect();
    const scaleX = el.width / rect.width;
    const scaleY = el.height / rect.height;
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
    const dCtx = drawCanvasRef.current?.getContext("2d");
    if (!dCtx) return;
    const pts = currentPointsRef.current;
    if (pts.length < 2) return;
    const t = toolRef.current;
    dCtx.save();
    if (t === "eraser") {
      dCtx.globalCompositeOperation = "destination-out";
      dCtx.strokeStyle = "rgba(0,0,0,1)";
      dCtx.lineWidth = penWidthRef.current * 5;
    } else {
      dCtx.globalCompositeOperation = "source-over";
      dCtx.strokeStyle = penColorRef.current;
      dCtx.lineWidth = penWidthRef.current;
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
    currentPointsRef.current = [];
    if (pts.length < 2) return;
    const t = toolRef.current;
    const strokeTool = t === "select" ? "pen" : t;
    const stroke: DrawingStroke = {
      color: strokeTool === "eraser" ? "#000000" : penColorRef.current,
      width: strokeTool === "eraser" ? penWidthRef.current * 5 : penWidthRef.current,
      points: [...pts],
      tool: strokeTool,
    };
    onNewStrokeRef.current(pageNumRef.current, stroke);
  }

  return (
    <div style={{ position: "relative" }}>
      {/* PDF canvas — CSS-scaled to container width */}
      <canvas ref={pdfCanvasRef} style={{ display: "block", width: "100%", height: "auto" }} />
      {/* Annotation highlight overlay */}
      <canvas
        ref={highlightCanvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      {/* Selectable text layer */}
      <div
        ref={textLayerRef}
        className="ep-pdf-textlayer"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          overflow: "hidden",
          pointerEvents: tool === "select" ? "auto" : "none",
          userSelect: tool === "select" ? "text" : "none",
        }}
        onMouseUp={tool === "select" ? onTextLayerMouseUp : undefined}
        onClick={tool === "select" ? onTextLayerClick : undefined}
      />
      {/* Drawing canvas */}
      <canvas
        ref={drawCanvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          touchAction: "none",
          cursor: tool === "select" ? "default" : "crosshair",
          pointerEvents: tool === "select" ? "none" : "auto",
        }}
        onMouseDown={onDrawMouseDown}
        onMouseMove={onDrawMouseMove}
        onMouseUp={onDrawMouseUp}
        onMouseLeave={onDrawMouseUp}
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

  const [noteDraft, setNoteDraft] = useState("");
  const [pendingSelection, setPendingSelection] = useState<SelectionInfo | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (comment: string) =>
      annotationsApi.create(projectId, {
        record_id: item.record_id ?? null,
        cluster_id: item.cluster_id ?? null,
        selected_text: pendingSelection?.text ?? "",
        comment,
        page_num: pendingSelection?.pageNum ?? null,
        highlight_rects: pendingSelection?.rects ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["annotations", itemKey] });
      setNoteDraft("");
      setPendingSelection(null);
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
    return () => { cancelled = true; };
  }, [projectId, meta?.id]);

  useEffect(
    () => () => { if (prevUrl.current) URL.revokeObjectURL(prevUrl.current); },
    []
  );

  // ── PDF.js doc ────────────────────────────────────────────────────────────────
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
    return () => { cancelled = true; };
  }, [blobUrl]);

  // ── Drawing state ─────────────────────────────────────────────────────────────
  const [drawingData, setDrawingData] = useState<DrawingData>({});
  const [tool, setTool] = useState<Tool>("select");
  const [penColor, setPenColor] = useState("#e53e3e");
  const [penWidth, setPenWidth] = useState(3);
  const drawingDataRef = useRef<DrawingData>(drawingData);
  drawingDataRef.current = drawingData;

  useEffect(() => {
    if (meta?.drawing_data) {
      setDrawingData(meta.drawing_data as DrawingData);
    } else {
      setDrawingData({});
    }
  }, [meta?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMut = useMutation({
    mutationFn: ({ pdfId, data }: { pdfId: string; data: DrawingData }) =>
      fulltextApi.saveDrawing(projectId, pdfId, data),
    onSuccess: (res) => {
      qc.setQueryData(["fulltext-pdf", projectId, itemKey], res.data);
    },
  });

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleSave() {
    if (!meta?.id) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const pdfId = meta.id;
    saveTimerRef.current = setTimeout(() => {
      saveMut.mutate({ pdfId, data: drawingDataRef.current });
    }, SAVE_DEBOUNCE_MS);
  }

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  function handleNewStroke(pNum: number, stroke: DrawingStroke) {
    const key = String(pNum);
    setDrawingData((prev) => {
      const updated = { ...prev, [key]: [...(prev[key] ?? []), stroke] };
      return updated;
    });
    scheduleSave();
  }

  function clearCurrentPage() {
    const key = String(pageNum);
    setDrawingData((prev) => ({ ...prev, [key]: [] }));
    scheduleSave();
  }

  // ── Layout mode ───────────────────────────────────────────────────────────────
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("single");

  // Page step depends on layout
  function prevPage() {
    setPageNum((p) => Math.max(1, p - (layoutMode === "two" ? 2 : 1)));
  }
  function nextPage() {
    setPageNum((p) => Math.min(numPages, p + (layoutMode === "two" ? 2 : 1)));
  }
  const atStart = pageNum <= 1;
  const atEnd = layoutMode === "two" ? pageNum + 1 >= numPages : pageNum >= numPages;

  // ── Panel position & size ─────────────────────────────────────────────────────
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [width, setWidth] = useState(INIT_WIDTH);
  const [minimized, setMinimized] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pos === null) {
      setPos({ left: window.innerWidth - INIT_WIDTH - INIT_RIGHT, top: INIT_HEIGHT_OFFSET });
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
        p ? { ...p, left: resizeStart.current!.initLeft - (next - resizeStart.current!.initW) } : p
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
  const savingLabel = saveMut.isPending ? "Saving…" : saveMut.isError ? "⚠ Save failed" : "";

  // ── Shared SinglePageView props ───────────────────────────────────────────────
  const sharedPageProps = {
    pdfDoc,
    tool,
    penColor,
    penWidth,
    annotations,
    activeNoteId,
    onNewStroke: handleNewStroke,
    onTextSelect: (info: SelectionInfo) => setSelectionInfo(info),
    onAnnotationClick: (annId: string, pNum: number) => {
      setActiveNoteId(annId === activeNoteId ? null : annId);
      if (layoutMode === "single") setPageNum(pNum);
      setNotesOpen(true);
    },
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
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

  const divider: React.CSSProperties = {
    width: "1px",
    height: "20px",
    background: "#e2e8f0",
    margin: "0 0.15rem",
  };

  return (
    <div ref={panelRef} style={panelStyle} aria-label="PDF viewer panel">
      {/* pdfjs 5.x TextLayer CSS — must mirror pdf_viewer.css for spans to be sized/positioned correctly */}
      <style>{`
        .ep-pdf-textlayer {
          position: absolute;
          top: 0; left: 0;
          overflow: hidden;
          line-height: 1;
          -webkit-text-size-adjust: none;
          text-size-adjust: none;
          transform-origin: 0 0;
          z-index: 0;
          /* CSS custom-property chain that pdfjs render() depends on */
          --min-font-size: 1;
          --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
          --min-font-size-inv: calc(1 / var(--min-font-size));
        }
        /* pdfjs places text as absolutely-positioned transparent spans */
        .ep-pdf-textlayer :is(span, br) {
          color: transparent;
          position: absolute;
          white-space: pre;
          cursor: text;
          transform-origin: 0% 0%;
        }
        /* pdfjs 5.x sizes and transforms each span via per-span CSS vars */
        .ep-pdf-textlayer > :not(.markedContent),
        .ep-pdf-textlayer .markedContent span:not(.markedContent) {
          z-index: 1;
          --font-height: 0;
          font-size: calc(var(--text-scale-factor) * var(--font-height));
          --scale-x: 1;
          --rotate: 0deg;
          transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
        }
        .ep-pdf-textlayer .markedContent { display: contents; }
        .ep-pdf-textlayer span::selection,
        .ep-pdf-textlayer ::selection {
          background: rgba(79, 70, 229, 0.28) !important;
          color: transparent !important;
        }
        .ep-pdf-textlayer .highlight {
          margin: -1px; padding: 1px;
          background-color: rgba(79, 70, 229, 0.18);
          border-radius: 3px;
        }
      `}</style>
      {!minimized && (
        <div
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "5px", cursor: "ew-resize", zIndex: 1 }}
          onMouseDown={onResizeMouseDown}
        />
      )}

      {/* Header */}
      <div style={headerStyle} onMouseDown={onHeaderMouseDown}>
        <span style={{ fontSize: "0.9rem", pointerEvents: "none" }}>📄</span>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pointerEvents: "none" }}
          title={filename || "PDF Viewer"}
        >
          {displayName || "PDF Viewer"}
        </span>
        {savingLabel && (
          <span style={{ fontSize: "0.7rem", opacity: 0.85, pointerEvents: "none" }}>{savingLabel}</span>
        )}
        <button style={iconBtn} title={minimized ? "Expand" : "Minimise"} onClick={() => setMinimized((v) => !v)}>
          {minimized ? "▲" : "▼"}
        </button>
        {blobUrl && !minimized && (
          <a href={blobUrl} download={filename} style={{ ...iconBtn, textDecoration: "none" }} title="Download PDF">
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
              {/* Layout mode */}
              <button
                style={{ ...toolBtn(layoutMode === "single"), display: "flex", alignItems: "center", gap: "0.2rem" }}
                onClick={() => setLayoutMode("single")}
                title="Single page"
              >
                <BookOpen size={13} />
              </button>
              <button
                style={{ ...toolBtn(layoutMode === "two"), display: "flex", alignItems: "center", gap: "0.2rem" }}
                onClick={() => setLayoutMode("two")}
                title="Two pages side by side"
              >
                <Columns2 size={13} />
              </button>
              <button
                style={{ ...toolBtn(layoutMode === "continuous"), display: "flex", alignItems: "center", gap: "0.2rem" }}
                onClick={() => setLayoutMode("continuous")}
                title="Continuous scroll"
              >
                <AlignJustify size={13} />
              </button>

              <div style={divider} />

              {/* Page navigation (hidden in continuous mode) */}
              {layoutMode !== "continuous" && (
                <>
                  <button style={toolBtn(false)} disabled={atStart} onClick={prevPage} title="Previous page">
                    <ChevronLeft size={14} />
                  </button>
                  <span style={{ fontSize: "0.75rem", color: "#475569", minWidth: "3.5rem", textAlign: "center" }}>
                    {layoutMode === "two"
                      ? `${pageNum}–${Math.min(pageNum + 1, numPages)} / ${numPages}`
                      : `${pageNum} / ${numPages}`}
                  </span>
                  <button style={toolBtn(false)} disabled={atEnd} onClick={nextPage} title="Next page">
                    <ChevronRight size={14} />
                  </button>
                  <div style={divider} />
                </>
              )}

              {/* Tool selector */}
              <button
                style={{ ...toolBtn(tool === "select"), display: "flex", alignItems: "center", gap: "0.25rem" }}
                onClick={() => setTool("select")}
                title="Select text"
              >
                <MousePointer2 size={13} /> Select
              </button>
              <button
                style={{ ...toolBtn(tool === "pen"), display: "flex", alignItems: "center", gap: "0.25rem" }}
                onClick={() => setTool("pen")}
                title="Draw"
              >
                <Pen size={13} /> Pen
              </button>
              <button
                style={{ ...toolBtn(tool === "eraser"), display: "flex", alignItems: "center", gap: "0.25rem" }}
                onClick={() => setTool("eraser")}
                title="Erase"
              >
                <Eraser size={13} /> Eraser
              </button>

              <div style={divider} />

              {/* Color + width */}
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

              {/* Clear page — shown in single/two modes only */}
              {layoutMode !== "continuous" && (
                <button
                  style={{ ...toolBtn(false), marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.25rem", color: "#991b1b", borderColor: "#fca5a5" }}
                  onClick={clearCurrentPage}
                  title="Clear drawings on this page"
                >
                  <Trash2 size={12} /> Clear
                </button>
              )}
            </div>
          )}

          {/* PDF canvas area */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              position: "relative",
              background: "#e2e8f0",
              minHeight: 0,
            }}
          >
            {/* Empty / loading / error states */}
            {!meta && !pdfLoading && !metaLoading && (
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

            {/* ── Single page ── */}
            {pdfDoc && layoutMode === "single" && (
              <div style={{ position: "relative" }}>
                <SinglePageView
                  {...sharedPageProps}
                  pageNum={pageNum}
                  drawingStrokes={drawingData[String(pageNum)] ?? []}
                />
              </div>
            )}

            {/* ── Two pages side by side ── */}
            {pdfDoc && layoutMode === "two" && (
              <div style={{ display: "flex", gap: "4px", alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <SinglePageView
                    {...sharedPageProps}
                    pageNum={pageNum}
                    drawingStrokes={drawingData[String(pageNum)] ?? []}
                  />
                </div>
                {pageNum + 1 <= numPages && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SinglePageView
                      {...sharedPageProps}
                      pageNum={pageNum + 1}
                      drawingStrokes={drawingData[String(pageNum + 1)] ?? []}
                    />
                  </div>
                )}
              </div>
            )}

            {/* ── Continuous scroll ── */}
            {pdfDoc && layoutMode === "continuous" && (
              <div style={{ padding: "4px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                  <SinglePageView
                    key={p}
                    {...sharedPageProps}
                    pageNum={p}
                    drawingStrokes={drawingData[String(p)] ?? []}
                  />
                ))}
              </div>
            )}

            {/* Selection popup */}
            {selectionInfo && (
              <div
                style={{
                  position: "fixed",
                  left: Math.min(selectionInfo.popupX, window.innerWidth - 240),
                  top: selectionInfo.popupY - 48,
                  background: "#fff",
                  border: "1.5px solid #4f46e5",
                  borderRadius: "0.4rem",
                  padding: "0.3rem 0.55rem",
                  display: "flex",
                  gap: "0.45rem",
                  alignItems: "center",
                  boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
                  zIndex: 400,
                  fontSize: "0.8rem",
                }}
              >
                <span style={{ color: "#64748b", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  "{selectionInfo.text.length > 35 ? selectionInfo.text.slice(0, 35) + "…" : selectionInfo.text}"
                </span>
                <button
                  onClick={() => {
                    setPendingSelection(selectionInfo);
                    setSelectionInfo(null);
                    setNotesOpen(true);
                    window.getSelection()?.removeAllRanges();
                  }}
                  style={{ background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.25rem", padding: "0.2rem 0.55rem", cursor: "pointer", fontSize: "0.75rem", fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  + Note
                </button>
                <button
                  onClick={() => { setSelectionInfo(null); window.getSelection()?.removeAllRanges(); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: "0.9rem", lineHeight: 1, padding: "0.1rem" }}
                >
                  ×
                </button>
              </div>
            )}
          </div>

          {/* Notes drawer */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #e2e8f0", background: "#fafafa" }}>
            <div
              style={{ display: "flex", alignItems: "center", padding: "0.3rem 0.65rem", cursor: "pointer", userSelect: "none", gap: "0.4rem" }}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em" }}>
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
                      onClick={() => {
                        setActiveNoteId(a.id === activeNoteId ? null : a.id);
                        if (a.page_num != null && layoutMode === "single") setPageNum(a.page_num);
                      }}
                      style={{
                        background: a.id === activeNoteId ? "#eef2ff" : "#fffde7",
                        borderLeft: `3px solid ${a.id === activeNoteId ? "#4f46e5" : "#fdd835"}`,
                        padding: "0.35rem 0.6rem",
                        marginBottom: "0.3rem",
                        fontSize: "0.78rem",
                        position: "relative",
                        borderRadius: "0 0.25rem 0.25rem 0",
                        cursor: "pointer",
                      }}
                    >
                      {a.page_num != null && (
                        <span style={{ fontSize: "0.68rem", color: "#4f46e5", fontWeight: 600, marginBottom: "0.2rem", display: "inline-block" }}>
                          p.{a.page_num}
                          {layoutMode === "single" && a.page_num !== pageNum && (
                            <span style={{ marginLeft: "0.3rem", opacity: 0.7 }}>↵ jump</span>
                          )}
                        </span>
                      )}
                      {a.selected_text && (
                        <blockquote style={{ margin: "0.1rem 0 0.25rem", fontStyle: "italic", color: "#555", fontSize: "0.74rem", borderLeft: "none", paddingLeft: 0 }}>
                          "{a.selected_text.length > 120 ? a.selected_text.slice(0, 120) + "…" : a.selected_text}"
                        </blockquote>
                      )}
                      {a.comment && (
                        <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{a.comment}</span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAnnotation(a.id);
                          if (activeNoteId === a.id) setActiveNoteId(null);
                        }}
                        style={{ position: "absolute", top: "0.25rem", right: "0.25rem", background: "none", border: "none", cursor: "pointer", color: "#c5221f", fontSize: "0.75rem", lineHeight: 1 }}
                        title="Delete note"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div style={{ padding: "0.35rem 0.65rem 0.5rem", borderTop: "1px solid #e2e8f0", flexShrink: 0 }}>
                  {pendingSelection && (
                    <div style={{ background: "#eef2ff", borderLeft: "3px solid #4f46e5", padding: "0.25rem 0.5rem", marginBottom: "0.4rem", fontSize: "0.74rem", color: "#3730a3", borderRadius: "0 0.25rem 0.25rem 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.4rem" }}>
                      <em style={{ flex: 1, lineHeight: 1.4 }}>
                        p.{pendingSelection.pageNum}: "{pendingSelection.text.length > 80 ? pendingSelection.text.slice(0, 80) + "…" : pendingSelection.text}"
                      </em>
                      <button onClick={() => setPendingSelection(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6366f1", fontSize: "0.8rem", lineHeight: 1, flexShrink: 0 }}>×</button>
                    </div>
                  )}
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={pendingSelection ? "Add a note about this selection…" : "Add a note about this paper…"}
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
