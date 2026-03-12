/**
 * PDFFetchButton — surfaces candidate full-text URLs for a paper and
 * orchestrates PDF capture via the EvidencePlatform browser extension.
 *
 * When the extension is installed:
 *   "Open & Capture" → opens the publisher page in a new tab,
 *   monitors the next PDF download, re-fetches it with the user's SSO
 *   cookies, and uploads it to the EP backend automatically.
 *
 * When the extension is absent:
 *   Links open normally in new tabs so the user can download and upload
 *   manually via the existing PDFUploadPanel.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getToken, fulltextApi } from "../api/client";
import type { ScreeningNextItem } from "../api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FulltextLink {
  url: string;
  label: string;
  source: string;
  is_oa: boolean;
  is_pdf: boolean;
}

type CaptureStatus = "idle" | "watching" | "success" | "error" | "manual";

// The EP backend base URL — must match what the extension will call.
const API_BASE = "http://localhost:8000";

// ── Styles ────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "#f0f4ff",
  border: "1px solid #c7d7fd",
  borderRadius: "0.375rem",
  padding: "0.6rem 0.9rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.45rem",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const chipBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.2rem",
  padding: "0.18rem 0.55rem",
  borderRadius: "1rem",
  fontSize: "0.76rem",
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
  border: "none",
  lineHeight: 1.4,
};

const oaBadge: React.CSSProperties = {
  ...chipBase,
  background: "#dcfce7",
  color: "#166534",
  fontSize: "0.68rem",
  padding: "0.1rem 0.4rem",
};

const pdfBadge: React.CSSProperties = {
  ...chipBase,
  background: "#fef9c3",
  color: "#854d0e",
  fontSize: "0.68rem",
  padding: "0.1rem 0.4rem",
};

const openBtn: React.CSSProperties = {
  ...chipBase,
  background: "#fff",
  color: "#1558d6",
  border: "1px solid #c7d7fd",
};

const captureBtn: React.CSSProperties = {
  ...chipBase,
  background: "#4f46e5",
  color: "#fff",
};

const cancelBtn: React.CSSProperties = {
  ...chipBase,
  background: "#fee2e2",
  color: "#991b1b",
  border: "1px solid #fca5a5",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function PDFFetchButton({
  projectId,
  item,
}: {
  projectId: string;
  item: ScreeningNextItem;
}) {
  const qc = useQueryClient();
  const itemKey = item.record_id ?? item.cluster_id;

  const [extensionReady, setExtensionReady] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureError, setCaptureError] = useState("");
  const [manualFilename, setManualFilename] = useState("");
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Extension detection & event bridge ──────────────────────────────────────

  useEffect(() => {
    const handleMsg = (e: MessageEvent) => {
      if (!e.data || typeof e.data.type !== "string") return;

      switch (e.data.type) {
        case "EP_EXTENSION_READY":
          setExtensionReady(true);
          break;

        case "EP_CAPTURE_SUCCESS":
          setCaptureStatus("success");
          // Invalidate so PDFUploadPanel below picks up the new file
          qc.invalidateQueries({ queryKey: ["fulltext-pdf", projectId, itemKey] });
          break;

        case "EP_CAPTURE_ERROR":
          setCaptureStatus("error");
          setCaptureError(e.data.error || "Unknown error");
          break;

        // Auto-capture failed after download completed — offer one-click manual upload
        case "EP_CAPTURE_FAILED_MANUAL":
          setCaptureStatus("manual");
          setManualFilename(e.data.filename || "document.pdf");
          setCaptureError(e.data.error || "");
          setExpanded(true);
          break;

        default:
          break;
      }
    };

    window.addEventListener("message", handleMsg);

    // Probe the extension. The content script replies with EP_EXTENSION_READY.
    // We retry a few times to handle the race where the content script hasn't
    // finished loading when this effect first runs.
    window.postMessage({ type: "EP_PROBE" }, "*");
    const t1 = setTimeout(() => window.postMessage({ type: "EP_PROBE" }, "*"), 400);
    const t2 = setTimeout(() => window.postMessage({ type: "EP_PROBE" }, "*"), 1200);

    return () => {
      window.removeEventListener("message", handleMsg);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [projectId, itemKey, qc]);

  // ── Candidate link fetch ─────────────────────────────────────────────────────

  const { data: links = [], isFetching } = useQuery<FulltextLink[]>({
    queryKey: ["fulltext-links", item.doi, item.pmid, item.pmcid, item.title],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (item.doi) params.set("doi", item.doi);
      if (item.pmid) params.set("pmid", item.pmid);
      if (item.pmcid) params.set("pmcid", item.pmcid);
      if (item.title) params.set("title", item.title);
      const res = await api.get<FulltextLink[]>(
        `/projects/${projectId}/fulltext/links?${params}`
      );
      return res.data;
    },
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });

  // ── Capture handler ──────────────────────────────────────────────────────────

  const openAndCapture = useCallback(
    (link: FulltextLink) => {
      const token = getToken();
      if (!token) return;

      setCaptureStatus("watching");
      setCaptureError("");

      window.postMessage(
        {
          type: "EP_WATCH_DOWNLOAD",
          projectId,
          recordId: item.record_id || null,
          clusterId: item.cluster_id || null,
          token,
          apiBase: API_BASE,
          targetUrl: link.url,
        },
        "*"
      );
    },
    [projectId, item.record_id, item.cluster_id]
  );

  const cancelWatch = () => {
    window.postMessage({ type: "EP_CANCEL_WATCH" }, "*");
    setCaptureStatus("idle");
  };

  const resetCapture = () => {
    setCaptureStatus("idle");
    setCaptureError("");
    setManualFilename("");
  };

  // Called when user picks the downloaded file for manual upload
  const handleManualFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await fulltextApi.upload(projectId, file, {
        record_id: item.record_id ?? undefined,
        cluster_id: item.cluster_id ?? undefined,
      });
      setCaptureStatus("success");
      qc.invalidateQueries({ queryKey: ["fulltext-pdf", projectId, itemKey] });
    } catch {
      setCaptureStatus("error");
      setCaptureError("Upload failed. Check the file and try again.");
    }
  };

  // ── No identifiers — nothing to show ────────────────────────────────────────

  if (!item.doi && !item.pmid && !item.pmcid && !item.title) return null;

  // ── Manual upload prompt (auto-capture failed, file already on disk) ─────────

  if (captureStatus === "manual") {
    return (
      <div style={{ ...card, background: "#fffbeb", border: "1px solid #fcd34d" }}>
        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#92400e" }}>
          PDF downloaded — attach it to this record
        </div>
        <div style={{ fontSize: "0.75rem", color: "#78350f" }}>
          Auto-capture failed ({captureError}). Your file was saved as{" "}
          <strong>{manualFilename}</strong>. Select it below to attach it.
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <label
            style={{ ...chipBase, background: "#4f46e5", color: "#fff", cursor: "pointer" }}
          >
            ↑ {manualFilename.length > 28 ? manualFilename.slice(0, 25) + "…" : manualFilename}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              style={{ display: "none" }}
              onChange={handleManualFile}
            />
          </label>
          <button onClick={resetCapture} style={{ ...cancelBtn }}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ── Success state ────────────────────────────────────────────────────────────

  if (captureStatus === "success") {
    return (
      <div style={{ ...card, background: "#f0fdf4", border: "1px solid #86efac" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ color: "#166534", fontWeight: 700, fontSize: "0.82rem" }}>
            ✓ PDF captured and saved to EvidencePlatform
          </span>
          <button
            onClick={resetCapture}
            style={{ ...chipBase, marginLeft: "auto", background: "#e0e7ff", color: "#3730a3" }}
          >
            Capture another
          </button>
        </div>
      </div>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  return (
    <div style={card}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span
          style={{
            color: "#3b4a7a",
            fontWeight: 700,
            fontSize: "0.73rem",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
          }}
        >
          Find PDF
        </span>

        {/* Extension status badge */}
        <span
          title={extensionReady ? "Extension connected" : "Extension not detected"}
          style={{
            fontSize: "0.68rem",
            fontWeight: 600,
            padding: "0.1rem 0.45rem",
            borderRadius: "1rem",
            background: extensionReady ? "#dcfce7" : "#fef3c7",
            color: extensionReady ? "#166534" : "#92400e",
          }}
        >
          {extensionReady ? "Extension ready" : "No extension"}
        </span>

        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            ...chipBase,
            marginLeft: "auto",
            background: "#e0e7ff",
            color: "#3730a3",
          }}
        >
          {expanded ? "▲ Hide" : "▼ Find links"}
        </button>
      </div>

      {/* Watching banner */}
      {captureStatus === "watching" && (
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: "0.25rem",
            padding: "0.35rem 0.6rem",
            fontSize: "0.78rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>
          <span>
            Watching for a PDF download… Complete login on the publisher site, then download
            the PDF.
          </span>
          <button onClick={cancelWatch} style={{ ...cancelBtn, marginLeft: "auto" }}>
            Cancel
          </button>
        </div>
      )}

      {/* Error banner */}
      {captureStatus === "error" && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: "0.25rem",
            padding: "0.35rem 0.6rem",
            fontSize: "0.78rem",
            color: "#991b1b",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span>Auto-capture failed: {captureError}. Please upload the file manually.</span>
          <button onClick={resetCapture} style={{ ...chipBase, background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5", marginLeft: "auto" }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Extension install hint */}
      {!extensionReady && expanded && (
        <div style={{ fontSize: "0.74rem", color: "#64748b", padding: "0.2rem 0" }}>
          Install the <strong>EvidencePlatform PDF Capture</strong> extension to enable
          one-click capture with institutional SSO.
        </div>
      )}

      {/* Link list */}
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {isFetching && (
            <span style={{ color: "#64748b", fontSize: "0.78rem" }}>Resolving links…</span>
          )}

          {!isFetching && links.length === 0 && (
            <span style={{ color: "#64748b", fontSize: "0.78rem" }}>
              No links found. Try searching Google Scholar.
            </span>
          )}

          {links.map((link) => (
            <div key={link.url} style={rowStyle}>
              {link.is_oa && <span style={oaBadge}>OA</span>}
              {link.is_pdf && <span style={pdfBadge}>PDF</span>}
              <span style={{ fontSize: "0.8rem", fontWeight: 500, flex: 1, minWidth: 0 }}>
                {link.label}
              </span>

              {/* Plain open link — always available */}
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                style={openBtn}
              >
                ↗ Open
              </a>

              {/* Extension capture button */}
              {extensionReady && captureStatus !== "watching" && (
                <button
                  onClick={() => openAndCapture(link)}
                  style={captureBtn}
                  title="Open this URL in a new tab and auto-capture the next PDF download"
                >
                  ⬇ Capture
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
