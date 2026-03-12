/**
 * PDFViewerPanel — floating PDF viewer for in-platform annotation during extraction.
 *
 * Renders as a fixed-position panel on the right side of the viewport, overlaying
 * the workspace without shifting layout. The PDF is fetched as a blob URL so that
 * it opens inside an <iframe> with the browser's native PDF renderer — no third-party
 * libraries required.
 *
 * Uses the same TanStack Query cache key as PDFUploadPanel, so metadata is served
 * from cache when the panel opens immediately after an upload.
 */
import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fulltextApi } from "../api/client";
import type { FulltextPdfMeta, ScreeningNextItem } from "../api/client";

interface Props {
  projectId: string;
  item: ScreeningNextItem;
  onClose: () => void;
}

export function PDFViewerPanel({ projectId, item, onClose }: Props) {
  const itemKey = item.record_id ?? item.cluster_id;

  // Re-use the same query key as PDFUploadPanel — served from cache immediately
  const { data: meta } = useQuery<FulltextPdfMeta | null>({
    queryKey: ["fulltext-pdf", projectId, itemKey],
    queryFn: () =>
      fulltextApi
        .getMeta(projectId, { record_id: item.record_id, cluster_id: item.cluster_id })
        .then((r) => r.data),
    enabled: !!itemKey,
    staleTime: 60_000,
  });

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(480);
  const [minimized, setMinimized] = useState(false);
  const prevUrl = useRef<string | null>(null);

  // Fetch blob whenever meta becomes available or changes
  useEffect(() => {
    if (!meta?.id) return;
    let cancelled = false;
    setLoading(true);
    setError("");

    fulltextApi
      .download(projectId, meta.id)
      .then((res) => {
        if (cancelled) return;
        // Revoke previous blob before creating a new one
        if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
        const url = URL.createObjectURL(res.data);
        prevUrl.current = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load PDF");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, meta?.id]);

  // Revoke on unmount
  useEffect(() => {
    return () => {
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
    };
  }, []);

  // ── Resize drag ────────────────────────────────────────────────────────────
  const dragStart = useRef<number | null>(null);
  const dragInitialWidth = useRef<number>(480);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = e.clientX;
    dragInitialWidth.current = width;

    const onMove = (me: MouseEvent) => {
      if (dragStart.current === null) return;
      const delta = dragStart.current - me.clientX;
      const next = Math.min(900, Math.max(280, dragInitialWidth.current + delta));
      setWidth(next);
    };
    const onUp = () => {
      dragStart.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const filename = meta?.original_filename ?? "";
  const displayName = filename.length > 34 ? filename.slice(0, 31) + "…" : filename;

  // ── Styles ─────────────────────────────────────────────────────────────────

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    right: 0,
    top: "3.5rem",
    width: minimized ? "220px" : `${width}px`,
    height: minimized ? "auto" : "calc(100vh - 3.5rem)",
    zIndex: 200,
    background: "#fff",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.14)",
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid #e2e8f0",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.4rem 0.65rem",
    background: "#4f46e5",
    color: "#fff",
    fontSize: "0.78rem",
    fontWeight: 600,
    flexShrink: 0,
    userSelect: "none",
    cursor: "default",
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
  };

  return (
    <div style={panelStyle} aria-label="PDF viewer panel">
      {/* Drag-to-resize handle on left edge */}
      {!minimized && <div style={dragHandle} onMouseDown={onMouseDown} />}

      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: "0.9rem" }}>📄</span>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={filename || "PDF Viewer"}
        >
          {displayName || "PDF Viewer"}
        </span>
        <button
          style={iconBtn}
          title={minimized ? "Expand" : "Minimise"}
          onClick={() => setMinimized((v) => !v)}
        >
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

      {/* Body */}
      {!minimized && (
        <div style={{ flex: 1, overflow: "hidden", position: "relative", background: "#f1f5f9" }}>
          {/* No PDF uploaded yet */}
          {!meta && !loading && (
            <div
              style={{
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
              }}
            >
              <span style={{ fontSize: "2rem" }}>📂</span>
              No PDF uploaded yet.
              <br />
              Use the PDF panel above to upload a file.
            </div>
          )}

          {loading && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#64748b",
                fontSize: "0.85rem",
                gap: "0.5rem",
              }}
            >
              <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>
              Loading PDF…
            </div>
          )}

          {error && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "#991b1b",
                fontSize: "0.82rem",
                gap: "0.5rem",
                padding: "1rem",
                textAlign: "center",
              }}
            >
              <span style={{ fontSize: "1.4rem" }}>⚠️</span>
              {error}
            </div>
          )}

          {blobUrl && !loading && (
            <iframe
              src={blobUrl}
              title="PDF viewer"
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
