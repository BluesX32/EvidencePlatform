import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { screeningApi, projectsApi, annotationsApi, labelsApi, ontologyApi } from "../api/client";
import type { ExtractionJson, ScreeningNextItem, SaturationStatus, ScreeningSource, ExtractionTemplateRow, QueueListEntry, ProjectLabel, OntologyNode } from "../api/client";
import LabelPicker from "../components/LabelPicker";
import ConceptPicker from "../components/ConceptPicker";
import { PDFFetchButton } from "../components/PDFFetchButton";
import { PDFViewerPanel } from "../components/PDFViewerPanel";
import { PDFUploadPanel } from "../components/PDFUploadPanel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDE_REASONS = [
  { code: "population", label: "Wrong population" },
  { code: "intervention", label: "Wrong intervention / exposure" },
  { code: "outcome", label: "Wrong outcome" },
  { code: "not_disease_severity", label: "Not disease severity" },
  { code: "study_design", label: "Wrong study design" },
  { code: "duplicate", label: "Duplicate" },
  { code: "other", label: "Other" },
];

const DEFAULT_LEVELS = [
  "gene", "molecular", "cellular", "tissue/organ",
  "patient/clinical", "population", "societal",
];


const BUCKET_LABELS: Record<string, string> = {
  ta_unscreened: "Screen (TA)",
  ta_included: "TA Included",
  ft_pending: "Full-text Review",
  ft_included: "FT Included",
  extract_pending: "Extract Data",
  extract_done: "Extracted",
};

const inputStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.85rem",
  width: "100%",
  boxSizing: "border-box",
};

// ---------------------------------------------------------------------------
// useLocalStorage
// ---------------------------------------------------------------------------

function useLocalStorage<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch { /* ignore */ }
    },
    [key]
  );
  return [value, set];
}

// ---------------------------------------------------------------------------
// Timing / session log
// ---------------------------------------------------------------------------

/** One screened-or-extracted record's timing entry, stored in localStorage. */
export interface TimingEntry {
  record_id?: string | null;
  cluster_id?: string | null;
  title: string;
  stage: "TA" | "FT" | "extract";
  decision: string; // "include" | "exclude" | "save"
  reason_code?: string;
  decided_at: string; // ISO 8601
  time_spent_seconds: number;
}

function useTimingLog(projectId: string) {
  const storageKey = `ep_timing_${projectId}`;
  const [entries, setEntries] = useState<TimingEntry[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as TimingEntry[]) : [];
    } catch {
      return [];
    }
  });

  const addEntry = useCallback(
    (entry: TimingEntry) => {
      setEntries((prev) => {
        const next = [...prev, entry];
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    },
    [storageKey]
  );

  const clearLog = useCallback(() => {
    setEntries([]);
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [storageKey]);

  return { entries, addEntry, clearLog };
}

// ---------------------------------------------------------------------------
// CSV utilities
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  "record_id", "cluster_id", "title", "stage",
  "decision", "reason_code", "decided_at", "time_spent_seconds",
];

function escapeCSVCell(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function entriesToCSVRows(entries: TimingEntry[]): string {
  const header = CSV_HEADERS.join(",");
  const rows = entries.map((e) =>
    [
      escapeCSVCell(e.record_id),
      escapeCSVCell(e.cluster_id),
      escapeCSVCell(e.title),
      escapeCSVCell(e.stage),
      escapeCSVCell(e.decision),
      escapeCSVCell(e.reason_code),
      escapeCSVCell(e.decided_at),
      escapeCSVCell(e.time_spent_seconds),
    ].join(",")
  );
  return [header, ...rows].join("\n");
}

function downloadTextFile(content: string, filename: string, mime = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse a CSV produced by this tool or imported externally. Returns entries + stats. */
function parseImportedCSV(text: string): {
  entries: TimingEntry[];
  errors: string[];
} {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { entries: [], errors: ["File is empty or has no data rows."] };

  // Parse header
  const rawHeader = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const col = (name: string) => rawHeader.indexOf(name);
  const ri = col("record_id");
  const ci = col("cluster_id");
  const ti = col("title");
  const si = col("stage");
  const di = col("decision");
  const rci = col("reason_code");
  const dai = col("decided_at");
  const tsi = col("time_spent_seconds");

  if (si === -1 || di === -1) {
    return { entries: [], errors: ["Missing required columns: 'stage' and 'decision' must be present."] };
  }

  const parseCell = (row: string[], idx: number) => {
    if (idx === -1) return "";
    const raw = row[idx] ?? "";
    return raw.replace(/^"|"$/g, "").replace(/""/g, '"').trim();
  };

  const entries: TimingEntry[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // Simple CSV split (handles quoted fields with commas inside)
    const row = lines[i].match(/("(?:[^"]|"")*"|[^,]*)/g)?.map((c) => c) ?? [];
    const stage = parseCell(row, si) as "TA" | "FT" | "extract";
    const decision = parseCell(row, di);
    if (!stage || !decision) {
      errors.push(`Row ${i + 1}: missing stage or decision.`);
      continue;
    }
    const tss = parseCell(row, tsi);
    entries.push({
      record_id: ri !== -1 ? parseCell(row, ri) || null : null,
      cluster_id: ci !== -1 ? parseCell(row, ci) || null : null,
      title: ti !== -1 ? parseCell(row, ti) : "(unknown)",
      stage,
      decision,
      reason_code: rci !== -1 ? parseCell(row, rci) || undefined : undefined,
      decided_at: dai !== -1 ? parseCell(row, dai) : "",
      time_spent_seconds: tss ? parseFloat(tss) : 0,
    });
  }

  return { entries, errors };
}

/** Compute aggregate stats from a list of timing entries. */
function computeStats(entries: TimingEntry[]) {
  const ta = entries.filter((e) => e.stage === "TA");
  const ft = entries.filter((e) => e.stage === "FT");
  const ex = entries.filter((e) => e.stage === "extract");

  const included = (arr: TimingEntry[]) => arr.filter((e) => e.decision === "include").length;
  const avgTime = (arr: TimingEntry[]) => {
    const valid = arr.filter((e) => e.time_spent_seconds > 0);
    if (!valid.length) return null;
    return Math.round(valid.reduce((s, e) => s + e.time_spent_seconds, 0) / valid.length);
  };

  const dates = entries
    .map((e) => e.decided_at)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => !isNaN(t));
  const earliest = dates.length ? new Date(Math.min(...dates)) : null;
  const latest = dates.length ? new Date(Math.max(...dates)) : null;

  const totalHours =
    earliest && latest && latest > earliest
      ? (latest.getTime() - earliest.getTime()) / 3_600_000
      : null;
  const rate =
    totalHours && totalHours > 0 ? Math.round(entries.length / totalHours) : null;

  return {
    total: entries.length,
    ta: { count: ta.length, included: included(ta), avgTime: avgTime(ta) },
    ft: { count: ft.length, included: included(ft), avgTime: avgTime(ft) },
    ex: { count: ex.length, avgTime: avgTime(ex) },
    earliest,
    latest,
    rate,
  };
}

// ---------------------------------------------------------------------------
// Shared helper components
// ---------------------------------------------------------------------------

function ProgressBar({
  remaining,
  queuePosition,
  queueTotal,
  queueSeed,
  sessionMax,
}: {
  remaining: number | null | undefined;
  queuePosition?: number | null;
  queueTotal?: number | null;
  queueSeed?: number | null;
  sessionMax?: number | null;
}) {
  if (queuePosition != null && queueTotal != null) {
    const pct = Math.round((queuePosition / queueTotal) * 100);
    return (
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            {sessionMax != null ? (
              <>
                <span style={{ fontWeight: 600, color: "#374151", fontSize: 14 }}>
                  {queuePosition} / {sessionMax}
                </span>
                <span style={{ color: "#6b7280", fontSize: 12 }}>·</span>
                <span style={{ fontWeight: 600, color: "#374151", fontSize: 14 }}>
                  {queuePosition} / {queueTotal}
                </span>
              </>
            ) : (
              <span style={{ fontWeight: 600, color: "#374151", fontSize: 14 }}>
                {queuePosition} / {queueTotal}
              </span>
            )}
          </span>
          {queueSeed != null && (
            <span style={{ color: "#9ca3af", fontSize: 11 }} title="Randomization seed — share with colleagues to reproduce this paper order">
              seed {queueSeed}
            </span>
          )}
        </div>
        <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2 }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "#6366f1", borderRadius: 2, transition: "width 0.3s" }} />
        </div>
      </div>
    );
  }
  if (remaining === undefined || remaining === null) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "0.75rem",
        fontSize: "0.8rem",
        color: "#5f6368",
      }}
    >
      <span
        style={{
          background: "#e8f0fe",
          color: "#1558d6",
          borderRadius: "1rem",
          padding: "0.12rem 0.65rem",
          fontWeight: 600,
          fontSize: "0.78rem",
        }}
      >
        {remaining}
      </span>
      <span>remaining in queue</span>
    </div>
  );
}

function DoneCard({ bucketLabel, projectId }: { bucketLabel: string; projectId: string }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "3rem 2rem",
        background: "#f8fff8",
        border: "1px solid #b7dfc4",
        borderRadius: "0.75rem",
        maxWidth: 500,
        margin: "2rem auto",
      }}
    >
      <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>✓</div>
      <h2 style={{ margin: "0 0 0.5rem" }}>All done!</h2>
      <p style={{ color: "#5f6368", marginBottom: "1.5rem" }}>
        No more items for {bucketLabel}.
      </p>
      <Link to={`/projects/${projectId}`} className="btn-primary">
        ← Back to project
      </Link>
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
  projectId,
}: {
  message: string;
  onRetry: () => void;
  projectId: string;
}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "2.5rem 2rem",
        background: "#fff8f8",
        border: "1px solid #f5c6c6",
        borderRadius: "0.75rem",
        maxWidth: 500,
        margin: "2rem auto",
      }}
    >
      <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>⚠</div>
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>Couldn't load next item</h2>
      <p style={{ color: "#5f6368", marginBottom: "1.5rem", fontSize: "0.9rem" }}>{message}</p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
        <button className="btn-primary" onClick={onRetry}>
          Retry
        </button>
        <Link to={`/projects/${projectId}`} className="btn-secondary">
          ← Back to project
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnnotationsPanel
// ---------------------------------------------------------------------------

function AnnotationsPanel({
  projectId,
  item,
}: {
  projectId: string;
  item: ScreeningNextItem;
}) {
  const queryClient = useQueryClient();
  // "highlight" = triggered by text selection; "note" = triggered by button
  const [formMode, setFormMode] = useState<null | "highlight" | "note">(null);
  const [selectedText, setSelectedText] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  // Prevents the mouseup from the Save/Cancel click re-opening the form
  const ignoreNextMouseup = useRef(false);

  const itemKey = item.record_id ?? item.cluster_id;

  const { data: annotations = [] } = useQuery({
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

  const createMutation = useMutation({
    mutationFn: () =>
      annotationsApi.create(projectId, {
        record_id: item.record_id ?? null,
        cluster_id: item.cluster_id ?? null,
        selected_text: selectedText,
        comment: commentDraft,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", itemKey] });
      closeForm();
    },
  });

  // Document-level mouseup captures text selected anywhere in the paper card.
  // We only act when the form is not already open, and skip the mouseup
  // triggered by clicking Save/Cancel (guarded by ignoreNextMouseup).
  useEffect(() => {
    const handler = () => {
      if (ignoreNextMouseup.current) {
        ignoreNextMouseup.current = false;
        return;
      }
      if (formMode !== null) return;
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel.length > 2) {
        setSelectedText(sel);
        setFormMode("highlight");
      }
    };
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, [formMode]);

  function closeForm() {
    ignoreNextMouseup.current = true;
    setFormMode(null);
    setSelectedText("");
    setCommentDraft("");
    window.getSelection()?.removeAllRanges();
  }

  function openNoteForm() {
    ignoreNextMouseup.current = true;
    setSelectedText("");
    setCommentDraft("");
    setFormMode("note");
  }

  function deleteAnnotation(annId: string) {
    annotationsApi.delete(projectId, annId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["annotations", itemKey] });
    });
  }

  // Can save if there is at least one non-empty field
  const canSave = (selectedText.trim().length > 0 || commentDraft.trim().length > 0) && !createMutation.isPending;

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {annotations.map((a) => (
        <div
          key={a.id}
          style={{
            background: "#fffde7",
            borderLeft: "3px solid #fdd835",
            padding: "0.5rem 0.75rem",
            marginBottom: "0.4rem",
            fontSize: "0.82rem",
            position: "relative",
          }}
        >
          {/* Highlighted quote — only shown when text was selected */}
          {a.selected_text && (
            <blockquote
              style={{
                margin: "0 0 0.25rem",
                fontStyle: "italic",
                color: "#555",
                fontSize: "0.8rem",
                background: "#fff9c4",
                padding: "0.15rem 0.35rem",
                borderRadius: "0.2rem",
              }}
            >
              "{a.selected_text}"
            </blockquote>
          )}
          {a.comment && <span style={{ whiteSpace: "pre-wrap" }}>{a.comment}</span>}
          <button
            onClick={() => deleteAnnotation(a.id)}
            style={{
              position: "absolute",
              top: "0.4rem",
              right: "0.4rem",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#c5221f",
              fontSize: "0.8rem",
              lineHeight: 1,
            }}
            title="Delete annotation"
          >
            ✕
          </button>
        </div>
      ))}

      {formMode !== null && (
        <div
          style={{
            background: "#f8f9fa",
            border: "1px solid #dadce0",
            borderRadius: "0.375rem",
            padding: "0.75rem",
            marginTop: "0.25rem",
          }}
        >
          {/* Show the captured highlight when in highlight mode */}
          {formMode === "highlight" && selectedText && (
            <div
              style={{
                fontStyle: "italic",
                fontSize: "0.8rem",
                color: "#555",
                marginBottom: "0.4rem",
                background: "#fff9c4",
                padding: "0.2rem 0.4rem",
                borderRadius: "0.2rem",
              }}
            >
              "{selectedText}"
            </div>
          )}
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontSize: "0.85rem",
              fontFamily: "inherit",
              border: "1px solid #dadce0",
              borderRadius: "0.25rem",
              padding: "0.3rem 0.4rem",
              resize: "vertical",
            }}
            placeholder={formMode === "highlight" ? "Comment on this highlight (optional)…" : "Your note…"}
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
            <button
              className="btn-primary"
              onClick={() => createMutation.mutate()}
              disabled={!canSave}
              style={{ fontSize: "0.82rem" }}
            >
              Save
            </button>
            <button
              className="btn-secondary"
              onClick={closeForm}
              style={{ fontSize: "0.82rem" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {formMode === null && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.3rem" }}>
          <span style={{ fontSize: "0.74rem", color: "#bbb", userSelect: "none" }}>
            Select text to highlight •
          </span>
          <button
            onClick={openNoteForm}
            style={{
              fontSize: "0.74rem",
              color: "#1a73e8",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              fontWeight: 500,
            }}
          >
            ➕ add note
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaperCard
// ---------------------------------------------------------------------------

const ABSTRACT_LIMIT = 420; // chars shown before "Show more"

function PaperCard({
  item,
  projectId,
  showAnnotations,
}: {
  item: ScreeningNextItem;
  projectId: string;
  showAnnotations?: boolean;
}) {
  const [abstractExpanded, setAbstractExpanded] = useState(false);
  const isLong = (item.abstract?.length ?? 0) > ABSTRACT_LIMIT;
  const displayAbstract =
    abstractExpanded || !isLong
      ? item.abstract
      : item.abstract!.slice(0, ABSTRACT_LIMIT).trimEnd() + "…";

  return (
    <div
      style={{
        border: "1px solid #dadce0",
        borderRadius: "0.5rem 0.5rem 0 0",
        borderBottom: "none",
        padding: "1.25rem 1.4rem 1rem",
        background: "#fff",
      }}
    >
      <h3
        style={{
          margin: "0 0 0.45rem",
          fontSize: "1.08rem",
          fontWeight: 700,
          lineHeight: 1.45,
          color: "#1a1a2e",
        }}
      >
        {item.title ?? <em style={{ color: "#888", fontWeight: 400 }}>No title</em>}
      </h3>

      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          flexWrap: "wrap",
          marginBottom: "0.6rem",
          fontSize: "0.83rem",
          color: "#5f6368",
          alignItems: "center",
        }}
      >
        {item.authors && item.authors.length > 0 && (
          <span>
            {item.authors.slice(0, 3).join(", ")}
            {item.authors.length > 3 ? " et al." : ""}
          </span>
        )}
        {item.year && (
          <>
            <span style={{ color: "#dadce0" }}>·</span>
            <span style={{ fontWeight: 500 }}>{item.year}</span>
          </>
        )}
        {item.doi && (
          <>
            <span style={{ color: "#dadce0" }}>·</span>
            <a
              href={`https://doi.org/${item.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.78rem", color: "#1a73e8", fontFamily: "monospace" }}
            >
              {item.doi}
            </a>
          </>
        )}
      </div>

      {(item.source_names ?? []).length > 0 && (
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
          {(item.source_names ?? []).map((s) => (
            <span
              key={s}
              style={{
                background: "#e8f0fe",
                color: "#1558d6",
                borderRadius: "1rem",
                padding: "0.08rem 0.55rem",
                fontSize: "0.74rem",
                fontWeight: 600,
                letterSpacing: "0.01em",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      )}

      {item.abstract && (
        <div>
          <p style={{ margin: "0 0 0.2rem", fontSize: "0.87rem", lineHeight: 1.65, color: "#3c4043" }}>
            {displayAbstract}
          </p>
          {isLong && (
            <button
              onClick={() => setAbstractExpanded((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "#1a73e8",
                fontSize: "0.79rem",
                cursor: "pointer",
                padding: "0.1rem 0",
              }}
            >
              {abstractExpanded ? "Show less ▲" : "Show more ▼"}
            </button>
          )}
        </div>
      )}

      {showAnnotations && <AnnotationsPanel projectId={projectId} item={item} />}
      {showAnnotations && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <LabelPicker projectId={projectId} recordId={item.record_id} clusterId={item.cluster_id} />
          <ConceptPicker projectId={projectId} recordId={item.record_id} clusterId={item.cluster_id} />
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// PDFUploadPanel
// ---------------------------------------------------------------------------

// PDFUploadPanel lives in components/PDFUploadPanel.tsx — imported below

// ---------------------------------------------------------------------------
// HistoryNav — prev / next article navigation bar
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// QueueNavigatorPanel — collapsible side panel listing all seen papers
// ---------------------------------------------------------------------------

function QueueNavigatorPanel({
  projectId,
  source,
  stage,
  currentPos,
  onNavigate,
  onClose,
}: {
  projectId: string;
  source: string;
  stage: string;
  currentPos: number | null;
  onNavigate: (pos: number) => void;
  onClose: () => void;
}) {
  const { data: list, isLoading } = useQuery<QueueListEntry[]>({
    queryKey: ["queue-list", projectId, source, stage],
    queryFn: () => screeningApi.getQueueList(projectId, { source, stage }).then((r) => r.data),
    refetchInterval: 8000,
  });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listRef.current || currentPos == null) return;
    const el = listRef.current.querySelector(`[data-pos="${currentPos}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentPos]);

  const decisionDot = (ta: string | null, ft: string | null) => {
    if (ft === "include") return <span style={{ color: "#188038", fontSize: "0.7rem", fontWeight: 700 }}>✓FT</span>;
    if (ft === "exclude") return <span style={{ color: "#c5221f", fontSize: "0.7rem", fontWeight: 700 }}>✕FT</span>;
    if (ta === "include") return <span style={{ color: "#1a73e8", fontSize: "0.7rem", fontWeight: 700 }}>✓TA</span>;
    if (ta === "exclude") return <span style={{ color: "#c5221f", fontSize: "0.7rem", fontWeight: 700 }}>✕TA</span>;
    return <span style={{ color: "#9ca3af", fontSize: "0.7rem" }}>—</span>;
  };

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: "0.5rem",
        background: "#fff",
        marginBottom: "0.6rem",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ padding: "0.5rem 0.85rem", borderBottom: "1px solid #e0e0e0", display: "flex", alignItems: "center", gap: "0.5rem", background: "#f9fafb" }}>
        <span style={{ fontWeight: 700, fontSize: "0.82rem", flex: 1, color: "#1f2937" }}>
          Papers in session ({list?.length ?? 0})
        </span>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: "1rem", lineHeight: 1, padding: "0.1rem 0.3rem" }}
          title="Close panel"
        >✕</button>
      </div>

      {/* List — capped height so it doesn't push the paper card too far down */}
      <div ref={listRef} style={{ maxHeight: 220, overflowY: "auto", padding: "0.15rem 0" }}>
        {isLoading && <p style={{ padding: "0.75rem 1rem", color: "#9ca3af", fontSize: "0.82rem" }}>Loading…</p>}
        {(list ?? []).map((entry) => {
          const isCurrent = entry.position === currentPos;
          const isExcluded = entry.ta_decision === "exclude";
          return (
            <div
              key={entry.position}
              data-pos={entry.position}
              onClick={() => onNavigate(entry.position)}
              style={{
                padding: "0.3rem 0.85rem",
                cursor: "pointer",
                background: isCurrent ? "#e8f0fe" : "transparent",
                borderLeft: `3px solid ${isCurrent ? "#4f46e5" : "transparent"}`,
                display: "flex",
                alignItems: "center",
                gap: "0.45rem",
              }}
              onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; }}
              onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <span style={{ color: "#9ca3af", fontSize: "0.72rem", minWidth: 22, textAlign: "right", flexShrink: 0 }}>
                {entry.position}
              </span>
              <span style={{
                flex: 1,
                fontSize: "0.79rem",
                lineHeight: 1.3,
                color: isExcluded ? "#9ca3af" : isCurrent ? "#1e40af" : "#374151",
                fontWeight: isCurrent ? 600 : 400,
                textDecoration: isExcluded ? "line-through" : "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {entry.title ?? "(No title)"}
              </span>
              <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                {decisionDot(entry.ta_decision, entry.ft_decision)}
              </span>
            </div>
          );
        })}
        {!isLoading && (!list || list.length === 0) && (
          <p style={{ padding: "0.65rem 1rem", color: "#9ca3af", fontSize: "0.82rem" }}>
            No papers screened yet.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HistoryDecisionPanel — inline editable decisions when browsing history
// ---------------------------------------------------------------------------

function HistoryDecisionPanel({
  item,
  onDecide,
  isPending,
}: {
  item: ScreeningNextItem;
  onDecide: (stage: "TA" | "FT", decision: "include" | "exclude", reason?: string) => void;
  isPending: boolean;
}) {
  const [expandTA, setExpandTA] = useState(false);
  const [expandFT, setExpandFT] = useState(false);

  const badge = (d: string | null | undefined) => {
    if (!d) return <em style={{ color: "#bbb", fontSize: "0.8rem" }}>none</em>;
    return (
      <strong style={{ color: d === "include" ? "#188038" : "#c5221f", fontSize: "0.82rem" }}>
        {d}
      </strong>
    );
  };

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem", flexWrap: "wrap",
  };

  const editBtn = (open: boolean, toggle: () => void) => (
    <button
      onClick={toggle}
      style={{
        fontSize: "0.72rem", padding: "0.1rem 0.45rem", borderRadius: "1rem",
        border: "1px solid #e0e0e0", background: open ? "#f3f0ff" : "#f9fafb",
        color: open ? "#4f46e5" : "#6b7280", cursor: "pointer", fontWeight: 500,
      }}
    >
      {open ? "✕ cancel" : "✎ change"}
    </button>
  );

  return (
    <div style={{
      background: "#f8f9fa", border: "1px solid #e0e0e0",
      borderRadius: "0.5rem", padding: "0.65rem 1rem", marginTop: "0.5rem",
    }}>
      <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#6b7280", marginBottom: "0.45rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Current decisions (click ✎ to update)
      </div>

      {/* TA row */}
      <div style={rowStyle}>
        <span style={{ fontSize: "0.8rem", fontWeight: 600, minWidth: 38, color: "#374151" }}>TA</span>
        {badge(item.ta_decision)}
        {editBtn(expandTA, () => { setExpandTA((v) => !v); setExpandFT(false); })}
      </div>
      {expandTA && (
        <div style={{ marginBottom: "0.5rem", paddingLeft: "1rem", borderLeft: "2px solid #c7d7fd" }}>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
            <button
              disabled={isPending}
              onClick={() => { onDecide("TA", "include"); setExpandTA(false); }}
              style={{ padding: "0.2rem 0.7rem", borderRadius: "0.375rem", border: "1px solid #34a853", background: "#e6f4ea", color: "#188038", fontWeight: 600, cursor: "pointer", fontSize: "0.8rem" }}
            >
              ✓ Include (TA)
            </button>
          </div>
          <ExcludeControls
            onExclude={(reason) => { onDecide("TA", "exclude", reason); setExpandTA(false); }}
            disabled={isPending}
          />
        </div>
      )}

      {/* FT row — always show if there's any FT decision or TA=include */}
      {(item.ta_decision === "include" || item.ft_decision) && (
        <>
          <div style={rowStyle}>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, minWidth: 38, color: "#374151" }}>FT</span>
            {badge(item.ft_decision)}
            {editBtn(expandFT, () => { setExpandFT((v) => !v); setExpandTA(false); })}
          </div>
          {expandFT && (
            <div style={{ paddingLeft: "1rem", borderLeft: "2px solid #c7d7fd" }}>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
                <button
                  disabled={isPending}
                  onClick={() => { onDecide("FT", "include"); setExpandFT(false); }}
                  style={{ padding: "0.2rem 0.7rem", borderRadius: "0.375rem", border: "1px solid #34a853", background: "#e6f4ea", color: "#188038", fontWeight: 600, cursor: "pointer", fontSize: "0.8rem" }}
                >
                  ✓ Include (FT)
                </button>
              </div>
              <ExcludeControls
                onExclude={(reason) => { onDecide("FT", "exclude", reason); setExpandFT(false); }}
                disabled={isPending}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HistoryNav
// ---------------------------------------------------------------------------

function HistoryNav({
  currentPos,
  maxPos,
  onPrev,
  onNext,
  isFetching,
  onToggleList,
  listOpen,
}: {
  currentPos: number;
  maxPos: number;
  onPrev: () => void;
  onNext: () => void;
  isFetching: boolean;
  onToggleList?: () => void;
  listOpen?: boolean;
}) {
  const isAtEnd = currentPos === maxPos;
  const btnBase: React.CSSProperties = {
    padding: "0.25rem 0.7rem",
    borderRadius: "0.375rem",
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#374151",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    gap: "0.2rem",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "0.6rem",
      }}
    >
      <button
        onClick={onPrev}
        disabled={currentPos <= 1 || isFetching}
        style={{
          ...btnBase,
          opacity: currentPos <= 1 ? 0.35 : 1,
        }}
        title="Previous article in this session"
      >
        ← Prev
      </button>

      <span
        style={{
          fontSize: "0.75rem",
          color: isAtEnd ? "#6b7280" : "#f59e0b",
          fontWeight: isAtEnd ? 400 : 600,
          padding: "0.15rem 0.5rem",
          background: isAtEnd ? "#f3f4f6" : "#fefce8",
          borderRadius: "1rem",
          border: `1px solid ${isAtEnd ? "#e5e7eb" : "#fde68a"}`,
        }}
      >
        {maxPos === 0 ? "—" : `${currentPos} / ${maxPos}`}
        {!isAtEnd && " (history)"}
      </span>

      <button
        onClick={onNext}
        disabled={isFetching}
        style={btnBase}
        title={isAtEnd ? "Fetch next article" : "Forward in session history"}
      >
        {isAtEnd ? "Next item →" : "→ Newer"}
      </button>

      {onToggleList && (
        <button
          onClick={onToggleList}
          style={{
            ...btnBase,
            marginLeft: "auto",
            background: listOpen ? "#ede9fe" : "#f9fafb",
            color: listOpen ? "#4f46e5" : "#6b7280",
            border: `1px solid ${listOpen ? "#c4b5fd" : "#e5e7eb"}`,
          }}
          title="Toggle paper list panel"
        >
          ☰ List
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExcludeControls
// ---------------------------------------------------------------------------

function ExcludeControls({
  onExclude,
  disabled,
}: {
  onExclude: (reason_code?: string) => void;
  disabled: boolean;
}) {
  const [custom, setCustom] = useState("");
  const [savedReasons, setSavedReasons] = useLocalStorage<string[]>("ep_custom_exclude_reasons", []);
  const [pinnedReasons, setPinnedReasons] = useLocalStorage<string[]>("ep_pinned_exclude_reasons", ["not_disease_severity"]);
  const [showPinManager, setShowPinManager] = useState(false);

  // All available reason codes (built-in + custom saved)
  const allReasons: { code: string; label: string; isCustom?: boolean }[] = [
    ...EXCLUDE_REASONS,
    ...savedReasons.map((r) => ({ code: r, label: r, isCustom: true })),
  ];

  function submit(reason?: string) {
    onExclude(reason);
    setCustom("");
  }

  function submitCustom() {
    const trimmed = custom.trim();
    if (trimmed && !EXCLUDE_REASONS.some((r) => r.code === trimmed) && !savedReasons.includes(trimmed)) {
      setSavedReasons([...savedReasons, trimmed]);
    }
    submit(trimmed || undefined);
  }

  function removesaved(reason: string) {
    setSavedReasons(savedReasons.filter((r) => r !== reason));
    setPinnedReasons(pinnedReasons.filter((p) => p !== reason));
  }

  function togglePin(code: string) {
    setPinnedReasons(
      pinnedReasons.includes(code)
        ? pinnedReasons.filter((p) => p !== code)
        : [...pinnedReasons, code]
    );
  }

  const pinnedItems = allReasons.filter((r) => pinnedReasons.includes(r.code));

  const reasonChipStyle: React.CSSProperties = {
    padding: "0.18rem 0.6rem",
    borderRadius: "1rem",
    border: "1px solid #dadce0",
    background: "#f8f9fa",
    color: "#5f6368",
    fontSize: "0.74rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div>
      {/* ── Pinned quick-exclude shortcuts ── */}
      {pinnedItems.length > 0 && (
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.55rem", padding: "0.4rem 0.6rem", background: "#fff8f0", border: "1px solid #fed7aa", borderRadius: "0.375rem" }}>
          <span style={{ fontSize: "0.68rem", fontWeight: 700, color: "#c2410c", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>⚡ Quick</span>
          {pinnedItems.map((r) => (
            <button
              key={r.code}
              onClick={() => submit(r.code)}
              disabled={disabled}
              title={`Quick exclude — ${r.label}`}
              style={{
                padding: "0.28rem 0.75rem",
                borderRadius: "1rem",
                border: "1.5px solid #f97316",
                background: "#fff",
                color: "#c2410c",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.background = "#fff7ed"; }}
              onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.background = "#fff"; }}
            >
              ✕ {r.label}
            </button>
          ))}
          <button
            onClick={() => setShowPinManager((v) => !v)}
            title="Manage pinned shortcuts"
            style={{ marginLeft: "auto", padding: "0.15rem 0.4rem", borderRadius: "0.25rem", border: "1px solid #fed7aa", background: showPinManager ? "#fed7aa" : "transparent", color: "#92400e", fontSize: "0.72rem", cursor: "pointer" }}
          >
            ⚙
          </button>
        </div>
      )}

      {/* ── Pin manager ── */}
      {(showPinManager || pinnedItems.length === 0) && (
        <div style={{ marginBottom: "0.5rem", padding: "0.5rem 0.7rem", background: "#f8f9fa", border: "1px solid #e0e0e0", borderRadius: "0.375rem" }}>
          <div style={{ fontSize: "0.69rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.35rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>📌 Pin shortcuts to Quick bar</span>
            {pinnedItems.length > 0 && (
              <button onClick={() => setShowPinManager(false)} style={{ background: "none", border: "none", color: "#9aa0a6", fontSize: "0.72rem", cursor: "pointer", padding: 0 }}>✕ close</button>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
            {allReasons.map((r) => {
              const pinned = pinnedReasons.includes(r.code);
              return (
                <button
                  key={r.code}
                  onClick={() => togglePin(r.code)}
                  title={pinned ? "Unpin" : "Pin to Quick bar"}
                  style={{
                    padding: "0.18rem 0.6rem",
                    borderRadius: "1rem",
                    border: `1.5px solid ${pinned ? "#f97316" : "#dadce0"}`,
                    background: pinned ? "#fff7ed" : "#fff",
                    color: pinned ? "#c2410c" : "#5f6368",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    fontWeight: pinned ? 600 : 400,
                  }}
                >
                  {pinned ? "📌 " : ""}{r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Exclude button + reason chips ── */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={submitCustom}
          disabled={disabled}
          style={{
            padding: "0.5rem 1.1rem",
            background: "#fff",
            border: "2px solid #c5221f",
            borderRadius: "0.375rem",
            color: "#c5221f",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: "pointer",
            flexShrink: 0,
            lineHeight: 1.2,
          }}
        >
          ✕ Exclude
        </button>
        <span style={{ fontSize: "0.71rem", color: "#9aa0a6", flexShrink: 0 }}>reason:</span>

        {/* Built-in reasons */}
        {EXCLUDE_REASONS.map((r) => (
          <button
            key={r.code}
            onClick={() => submit(r.code)}
            disabled={disabled}
            title={`Exclude — ${r.label}`}
            style={reasonChipStyle}
            onMouseEnter={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = "#fce8e6";
              b.style.borderColor = "#c5221f";
              b.style.color = "#c5221f";
            }}
            onMouseLeave={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = "#f8f9fa";
              b.style.borderColor = "#dadce0";
              b.style.color = "#5f6368";
            }}
          >
            {r.label}
          </button>
        ))}

        {/* Custom saved reasons */}
        {savedReasons.map((r) => (
          <span key={r} style={{ display: "inline-flex", alignItems: "center", gap: "0.1rem" }}>
            <button
              onClick={() => submit(r)}
              disabled={disabled}
              title={`Exclude — ${r}`}
              style={{ ...reasonChipStyle, borderColor: "#c5d9f7", background: "#e8f0fe", color: "#1a73e8", borderRadius: "1rem 0 0 1rem", paddingRight: "0.4rem" }}
              onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.background = "#fce8e6"; b.style.borderColor = "#c5221f"; b.style.color = "#c5221f"; }}
              onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.background = "#e8f0fe"; b.style.borderColor = "#c5d9f7"; b.style.color = "#1a73e8"; }}
            >
              {r}
            </button>
            <button
              onClick={() => removesaved(r)}
              title="Remove this reason"
              style={{ padding: "0.18rem 0.35rem", borderRadius: "0 1rem 1rem 0", border: "1px solid #c5d9f7", borderLeft: "none", background: "#e8f0fe", color: "#9aa0a6", fontSize: "0.7rem", cursor: "pointer", lineHeight: 1 }}
              onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.color = "#c5221f"; b.style.background = "#fce8e6"; b.style.borderColor = "#f28b82"; }}
              onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.color = "#9aa0a6"; b.style.background = "#e8f0fe"; b.style.borderColor = "#c5d9f7"; }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <input
        type="text"
        placeholder="Type a custom reason and press Enter to save + exclude…"
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) submitCustom();
        }}
        disabled={disabled}
        style={{
          marginTop: "0.4rem",
          fontSize: "0.77rem",
          padding: "0.22rem 0.55rem",
          border: "1px solid #e0e0e0",
          borderRadius: "0.25rem",
          width: 300,
          color: "#3c4043",
          background: "#fafafa",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DecisionBar
// ---------------------------------------------------------------------------

function DecisionBar({
  stage,
  includeLabel,
  onInclude,
  onExclude,
  onSkip,
  isPending,
  isLoading,
  isError,
}: {
  stage: "TA" | "FT";
  includeLabel?: string;
  onInclude: () => void;
  onExclude: (reason_code?: string) => void;
  onSkip: () => void;
  isPending: boolean;
  isLoading?: boolean;
  isError?: boolean;
}) {
  const stageLabel = stage === "TA" ? "Title / Abstract" : "Full Text";
  const accent = stage === "TA" ? "#5f6368" : "#1558d6";

  return (
    <div
      style={{
        background: "#f8f9fa",
        border: "1px solid #e0e0e0",
        borderTop: `3px solid ${accent}`,
        borderRadius: "0 0 0.5rem 0.5rem",
        padding: "0.9rem 1.25rem 0.8rem",
        marginTop: 0,
        position: "sticky",
        bottom: 0,
        zIndex: 20,
      }}
    >
      <div
        style={{
          fontSize: "0.68rem",
          fontWeight: 700,
          color: accent,
          textTransform: "uppercase",
          letterSpacing: "0.09em",
          marginBottom: "0.7rem",
        }}
      >
        {stageLabel} · Decision
      </div>

      <div style={{ display: "flex", gap: "1.25rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <button
          onClick={onInclude}
          disabled={isPending}
          style={{
            padding: "0.52rem 1.35rem",
            background: "#188038",
            border: "none",
            borderRadius: "0.375rem",
            color: "#fff",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: "pointer",
            flexShrink: 0,
            letterSpacing: "0.01em",
            lineHeight: 1.25,
          }}
        >
          {includeLabel ?? "✓ Include"}
        </button>

        <div style={{ width: 1, background: "#dadce0", alignSelf: "stretch", flexShrink: 0 }} />

        <ExcludeControls onExclude={onExclude} disabled={isPending} />
      </div>

      {isError && (
        <p style={{ color: "#c5221f", fontSize: "0.79rem", margin: "0.45rem 0 0" }}>
          Failed to submit. Try again.
        </p>
      )}

      <button
        onClick={onSkip}
        disabled={isPending || isLoading}
        style={{
          marginTop: "0.6rem",
          background: "none",
          border: "none",
          color: "#9aa0a6",
          fontSize: "0.76rem",
          cursor: "pointer",
          padding: 0,
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textUnderlineOffset: "2px",
        }}
      >
        ↷ Skip — decide later
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScreeningPanel — sequential TA / FT / browse with history + timing
// ---------------------------------------------------------------------------

function ScreeningPanel({
  projectId,
  bucket,
  source,
  strategy,
  autoAdvanceExtract = false,
  levels = DEFAULT_LEVELS,
  onDecision,
  randomize = false,
  seed,
}: {
  projectId: string;
  bucket: string;
  source: string;
  strategy: string;
  autoAdvanceExtract?: boolean;
  levels?: string[];
  onDecision?: (entry: TimingEntry) => void;
  randomize?: boolean;
  seed?: number;
}) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [extractPhase, setExtractPhase] = useState(false);
  const [form, setForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);

  // Queue-position-based persistent history navigation.
  const [displayPos, setDisplayPos] = useState<number | null>(null);
  const [maxPos, setMaxPos] = useState<number | null>(null);
  const [queueTotal, setQueueTotal] = useState<number | null>(null);
  const [queueSeed, setQueueSeed] = useState<number | null>(null);

  // When browsing history this holds the fetched article; null = showing live item.
  const [browseItem, setBrowseItem] = useState<ScreeningNextItem | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const isBrowsingHistory = browseItem !== null;

  const [pdfOpen, setPdfOpen] = useState(false);
  const [showQueueNav, setShowQueueNav] = useState(false);
  const [showOverrideTA, setShowOverrideTA] = useState(false);

  const itemStartedAt = useRef<number>(Date.now());

  const bucketToMode: Record<string, string> = {
    ta_unscreened: "screen",
    ta_included: "screen",
    ft_pending: "fulltext",
    ft_included: "fulltext",
    extract_pending: "extract",
    extract_done: "extract",
  };
  const mode = bucketToMode[bucket] ?? "screen";
  const queueStage = mode;

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setExtractPhase(false);
    setForm(EMPTY_EXTRACTION);
    setBrowseItem(null);
    try {
      const res = await screeningApi.nextItem(projectId, { source_id: source, mode, strategy, bucket, randomize: randomize || undefined, seed: seed });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
        itemStartedAt.current = Date.now();
        const d = res.data;
        if (d.queue_position != null) {
          setDisplayPos(d.queue_position);
          setMaxPos(d.queue_position);
          setQueueTotal(d.queue_total ?? null);
          setQueueSeed(d.queue_seed ?? null);
        }
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error?.message ?? "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source, mode, strategy, bucket, randomize, seed]);

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

  // Navigate to a queue position — does NOT set global loading,
  // so the nav bar stays visible while the item is being fetched.
  async function navigateToPos(pos: number) {
    if (pos < 1 || maxPos === null || pos > maxPos) return;
    if (pos === maxPos) {
      // Back to the live item — no API call needed
      setBrowseItem(null);
      setDisplayPos(pos);
      itemStartedAt.current = Date.now();
      return;
    }
    setBrowseLoading(true);
    try {
      const res = await screeningApi.getQueueSlot(projectId, { source, stage: queueStage, position: pos });
      setBrowseItem(res.data);
      setDisplayPos(pos);
    } catch {
      // Silently ignore — stay on current position
    } finally {
      setBrowseLoading(false);
    }
  }

  async function goToPrev() {
    if (displayPos !== null && displayPos > 1) await navigateToPos(displayPos - 1);
  }

  async function goToNext() {
    if (displayPos !== null && maxPos !== null && displayPos < maxPos) {
      await navigateToPos(displayPos + 1);
    } else {
      await fetchNext();
    }
  }

  const decideMutation = useMutation({
    mutationFn: (body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      strategy?: string;
    }) => screeningApi.submitDecision(projectId, body),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: {
      record_id?: string | null;
      cluster_id?: string | null;
      extracted_json: ExtractionJson;
    }) => screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saturation", projectId] });
      fetchNext();
    },
  });

  const stage = bucket === "ta_unscreened" || bucket === "ta_included" ? "TA" : "FT";
  const isBrowseBucket = ["ta_included", "ft_included", "extract_done"].includes(bucket);
  const displayItem = browseItem ?? item;
  const bucketLabel = BUCKET_LABELS[bucket] ?? bucket;

  // Mutation for updating decisions on history-browse items (UPSERT on backend)
  const browseDecideMutation = useMutation({
    mutationFn: (body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      strategy?: string;
    }) => screeningApi.submitDecision(projectId, body),
    onSuccess: async () => {
      // Re-fetch the browse item to reflect updated decisions
      if (displayPos !== null && displayPos !== maxPos) {
        setBrowseLoading(true);
        try {
          const res = await screeningApi.getQueueSlot(projectId, { source, stage: queueStage, position: displayPos });
          setBrowseItem(res.data);
        } finally {
          setBrowseLoading(false);
        }
      }
      queryClient.invalidateQueries({ queryKey: ["queue-list", projectId] });
    },
  });

  function decide(decision: "include" | "exclude", reason_code?: string) {
    if (!item) return;
    const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
    decideMutation.mutate(
      { record_id: item.record_id ?? null, cluster_id: item.cluster_id ?? null, stage: stage as "TA" | "FT", decision, reason_code, strategy },
      {
        onSuccess: () => {
          onDecision?.({ record_id: item.record_id, cluster_id: item.cluster_id, title: item.title ?? "(unknown)", stage: stage as "TA" | "FT", decision, reason_code, decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
          if (decision === "include" && stage === "FT" && autoAdvanceExtract) {
            setExtractPhase(true);
          } else {
            fetchNext();
          }
        },
      }
    );
  }

  // Override TA decision while viewing this paper in FT stage
  function overrideTA(decision: "include" | "exclude", reason_code?: string) {
    if (!item) return;
    decideMutation.mutate(
      { record_id: item.record_id ?? null, cluster_id: item.cluster_id ?? null, stage: "TA", decision, reason_code, strategy },
      {
        onSuccess: () => {
          setShowOverrideTA(false);
          fetchNext();
        },
      }
    );
  }

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => { const arr = f[field]; return { ...f, [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] }; });
  }

  // The nav bar is always rendered once we have a position — never hidden by loading.
  const nav = maxPos !== null ? (
    <HistoryNav
      currentPos={displayPos ?? 1}
      maxPos={maxPos}
      onPrev={goToPrev}
      onNext={goToNext}
      isFetching={loading || browseLoading}
      onToggleList={() => setShowQueueNav((v) => !v)}
      listOpen={showQueueNav}
    />
  ) : null;

  // ── Initial load (no position yet) ──
  if (loading && maxPos === null) {
    return <p style={{ color: "#888" }}>Loading…</p>;
  }

  // ── Fetch error (and not currently browsing history) ──
  if (fetchError && !isBrowsingHistory) {
    return <>{nav}<ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} /></>;
  }

  // ── Queue exhausted ──
  if (!isBrowsingHistory && (!item || item.done)) {
    return <>{nav}<DoneCard bucketLabel={bucketLabel} projectId={projectId} /></>;
  }

  if (!displayItem) return nav;

  // ── Inline extraction after FT include ──
  if (extractPhase && !isBrowsingHistory && item) {
    return (
      <div>
        {nav}
        <ProgressBar remaining={item.remaining} queuePosition={displayPos ?? item.queue_position} queueTotal={queueTotal ?? item.queue_total} queueSeed={queueSeed ?? item.queue_seed} sessionMax={maxPos} />
        <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "0.85rem 1.1rem", marginBottom: "0.6rem", background: "#fff" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{item.title ?? <em style={{ color: "#888" }}>No title</em>}</div>
          <div style={{ fontSize: "0.82rem", color: "#5f6368", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {item.year && <span>{item.year}</span>}
            {(item.source_names ?? []).map((s) => (
              <span key={s} style={{ background: "#e8f0fe", color: "#1a73e8", borderRadius: "1rem", padding: "0 0.45rem", fontSize: "0.75rem" }}>{s}</span>
            ))}
          </div>
        </div>

        {/* PDF access in extraction stage */}
        <PDFFetchButton projectId={projectId} item={item} />
        <PDFUploadPanel projectId={projectId} item={item} />

        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.6rem", marginBottom: "0.9rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#8f3f97", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            ✓ FT Included — Extract Data
          </div>
          <button
            onClick={() => setPdfOpen((v) => !v)}
            style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: pdfOpen ? "#4f46e5" : "#fff", color: pdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
          >
            📄 {pdfOpen ? "Hide PDF" : "View PDF"}
          </button>
          {/* Escape hatch: change FT decision to exclude without losing the item */}
          <button
            onClick={() => {
              if (!window.confirm("Exclude this paper at Full-Text stage and return to screening?")) return;
              decide("exclude");
              setExtractPhase(false);
            }}
            disabled={decideMutation.isPending}
            style={{ marginLeft: "auto", fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #fca5a5", background: "#fff", color: "#991b1b", cursor: "pointer" }}
          >
            ✕ Exclude at FT
          </button>
        </div>
        <ExtractionForm
          projectId={projectId} form={form} setForm={setForm} levels={levels}
          onSave={() => {
            const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
            onDecision?.({ record_id: item.record_id, cluster_id: item.cluster_id, title: item.title ?? "(unknown)", stage: "extract", decision: "save", decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
            saveMutation.mutate({ record_id: item.record_id ?? null, cluster_id: item.cluster_id ?? null, extracted_json: form });
          }}
          onSkip={fetchNext} isPending={saveMutation.isPending} isError={saveMutation.isError} toggleChip={toggleChip}
        />
        {pdfOpen && <PDFViewerPanel projectId={projectId} item={item} onClose={() => setPdfOpen(false)} />}
      </div>
    );
  }

  // ── Main view ──
  return (
    <div>
      {nav}

      {/* Session paper list — inline collapsible below nav bar */}
      {showQueueNav && (
        <QueueNavigatorPanel
          projectId={projectId}
          source={source}
          stage={queueStage}
          currentPos={displayPos}
          onNavigate={(pos) => { navigateToPos(pos); }}
          onClose={() => setShowQueueNav(false)}
        />
      )}

      {/* Subtle spinner during history navigation — nav bar stays visible */}
      {browseLoading && (
        <div style={{ fontSize: "0.78rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Loading…</div>
      )}

      <ProgressBar remaining={isBrowsingHistory ? undefined : item?.remaining} queuePosition={displayPos ?? item?.queue_position} queueTotal={queueTotal ?? item?.queue_total} queueSeed={queueSeed ?? item?.queue_seed} sessionMax={maxPos} />

      {/* History mode banner */}
      {isBrowsingHistory && (
        <div style={{ background: "#fefce8", border: "1px solid #fde68a", borderRadius: "0.375rem", padding: "0.4rem 0.85rem", marginBottom: "0.5rem", fontSize: "0.78rem", color: "#92400e", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Viewing session history</span>
          <button onClick={() => maxPos !== null && navigateToPos(maxPos)} style={{ background: "none", border: "none", color: "#92400e", fontWeight: 600, cursor: "pointer", fontSize: "0.78rem", padding: 0 }}>
            Return to current →
          </button>
        </div>
      )}

      <PaperCard item={displayItem} projectId={projectId} showAnnotations />

      {!isBrowseBucket && stage === "FT" && !isBrowsingHistory && <PDFFetchButton projectId={projectId} item={displayItem} />}
      {!isBrowseBucket && stage === "FT" && !isBrowsingHistory && <PDFUploadPanel projectId={projectId} item={displayItem} />}
      {!isBrowseBucket && stage === "FT" && !isBrowsingHistory && (
        <div style={{ marginTop: "0.35rem" }}>
          <button
            onClick={() => setPdfOpen((v) => !v)}
            style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: pdfOpen ? "#4f46e5" : "#fff", color: pdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
          >
            📄 {pdfOpen ? "Hide PDF" : "View PDF"}
          </button>
        </div>
      )}
      {pdfOpen && item && <PDFViewerPanel projectId={projectId} item={item} onClose={() => setPdfOpen(false)} />}

      {!isBrowseBucket && !isBrowsingHistory && (
        <>
          <DecisionBar
            stage={stage as "TA" | "FT"}
            includeLabel={stage === "FT" && autoAdvanceExtract ? "✓ Include — extract data" : undefined}
            onInclude={() => decide("include")}
            onExclude={(reason) => decide("exclude", reason)}
            onSkip={fetchNext}
            isPending={decideMutation.isPending}
            isLoading={loading}
            isError={decideMutation.isError}
          />

          {/* Override TA decision while in FT stage */}
          {stage === "FT" && (
            <div style={{ marginTop: "0.4rem" }}>
              <button
                onClick={() => setShowOverrideTA((v) => !v)}
                style={{
                  fontSize: "0.75rem", padding: "0.18rem 0.65rem", borderRadius: "1rem",
                  border: "1px solid #fde68a", background: showOverrideTA ? "#fef9c3" : "#fff",
                  color: "#92400e", cursor: "pointer", fontWeight: 500,
                }}
              >
                ↩ Override abstract (TA) decision
              </button>
              {showOverrideTA && (
                <div style={{
                  marginTop: "0.4rem", padding: "0.6rem 0.85rem",
                  background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "0.375rem",
                }}>
                  <div style={{ fontSize: "0.75rem", color: "#92400e", marginBottom: "0.4rem" }}>
                    Submit a TA-level decision for this paper (overrides the existing abstract decision):
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
                    <button
                      disabled={decideMutation.isPending}
                      onClick={() => overrideTA("include")}
                      style={{ padding: "0.2rem 0.7rem", borderRadius: "0.375rem", border: "1px solid #34a853", background: "#e6f4ea", color: "#188038", fontWeight: 600, cursor: "pointer", fontSize: "0.8rem" }}
                    >
                      ✓ TA Include
                    </button>
                  </div>
                  <ExcludeControls
                    onExclude={(reason) => overrideTA("exclude", reason)}
                    disabled={decideMutation.isPending}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* History / browse bucket view — with editable decision override */}
      {(isBrowseBucket || isBrowsingHistory) && (
        <div>
          {!isBrowsingHistory && (
            <div style={{ background: "#f8f9fa", border: "1px solid #e0e0e0", borderRadius: "0.375rem", padding: "0.6rem 1.1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              {displayItem.ta_decision && (
                <span style={{ fontSize: "0.82rem", color: "#5f6368" }}>
                  TA: <strong style={{ color: displayItem.ta_decision === "include" ? "#188038" : "#c5221f" }}>{displayItem.ta_decision}</strong>
                </span>
              )}
              {displayItem.ft_decision && (
                <span style={{ fontSize: "0.82rem", color: "#5f6368" }}>
                  FT: <strong style={{ color: displayItem.ft_decision === "include" ? "#188038" : "#c5221f" }}>{displayItem.ft_decision}</strong>
                </span>
              )}
              <button className="btn-secondary" onClick={fetchNext} disabled={loading} style={{ marginLeft: "auto" }}>Next →</button>
            </div>
          )}
          {isBrowsingHistory && (
            <HistoryDecisionPanel
              item={displayItem}
              onDecide={(s, d, reason) =>
                browseDecideMutation.mutate({
                  record_id: displayItem.record_id ?? null,
                  cluster_id: displayItem.cluster_id ?? null,
                  stage: s,
                  decision: d,
                  reason_code: reason,
                  strategy,
                })
              }
              isPending={browseDecideMutation.isPending}
            />
          )}
        </div>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// SaturationBadge
// ---------------------------------------------------------------------------

const SATURATION_THRESHOLD = 5;

function SaturationBadge({ projectId, source }: { projectId: string; source?: string }) {
  const { data } = useQuery<SaturationStatus>({
    queryKey: ["saturation", projectId, source ?? "all"],
    queryFn: () => screeningApi.getSaturation(projectId, SATURATION_THRESHOLD, source).then((r) => r.data),
    staleTime: 0, // always fresh — invalidated after each save
  });

  if (!data) return null;

  const { consecutive_no_novelty: count, saturated, threshold } = data;
  const pct = Math.min(1, count / threshold);
  const bg = saturated ? "#fee2e2" : pct >= 0.6 ? "#fff7ed" : "#f9fafb";
  const borderColor = saturated ? "#fca5a5" : pct >= 0.6 ? "#fdba74" : "#e5e7eb";
  const textColor = saturated ? "#b91c1c" : pct >= 0.6 ? "#c2410c" : "#6b7280";
  const barColor = saturated ? "#ef4444" : pct >= 0.6 ? "#f97316" : count > 0 ? "#facc15" : "#22c55e";

  return (
    <div style={{ marginBottom: "1rem", padding: "10px 14px", borderRadius: 8, border: `1px solid ${borderColor}`, background: bg }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: textColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Framework Saturation
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: textColor }}>{count} / {threshold}</span>
      </div>
      <div style={{ height: 6, background: "#e5e7eb", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: barColor, borderRadius: 999, transition: "width 0.4s ease" }} />
      </div>
      <div style={{ marginTop: 5, fontSize: 11, color: textColor }}>
        {saturated
          ? `⚠️ ${threshold} papers in a row added no new framework concepts — consider stopping.`
          : count === 0
          ? data.total_extractions === 0
            ? "No extractions yet for this corpus."
            : "✅ Last paper added new framework concepts. Counter at zero."
          : `${count} consecutive paper${count > 1 ? "s" : ""} confirmed existing concepts only.`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExtractionForm
// ---------------------------------------------------------------------------

const EMPTY_EXTRACTION: ExtractionJson = {
  table: {},
  free_note: "",
  framework_updated: false,
  framework_update_note: "",
  levels: [],
  dimensions: [],
  snippets: [],
};

// ── ExtractionTable ──────────────────────────────────────────────────────────
// Template-driven extraction table.  Columns: Domain | Data Item | Data Extraction.
// Each row's input type is set by ExtractionTemplateRow.type.
// Falls back to a plain free-text note when no template is configured.

interface ExtractionFormProps {
  projectId: string;
  source?: string;           // current corpus — scopes the saturation counter
  form: ExtractionJson;
  setForm: React.Dispatch<React.SetStateAction<ExtractionJson>>;
  levels: string[];          // kept for back-compat; not used in table view
  onSave: () => void;
  onSkip: () => void;
  onGoBack?: () => void;     // navigate back to the previous extracted article
  isPending: boolean;
  isError: boolean;
  toggleChip: (field: "levels" | "dimensions", value: string) => void;
}

function ExtractionForm({ projectId, source, form, setForm, onSave, onSkip, onGoBack, isPending, isError }: ExtractionFormProps) {
  // Load the project's extraction template
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId).then((r) => r.data),
    staleTime: 60_000,
  });
  const templateRows: ExtractionTemplateRow[] = project?.extraction_template?.rows ?? [];

  // Labels and ontology nodes — used to show linked items as reference badges
  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId).then((r) => r.data),
    staleTime: 60_000,
  });
  const { data: allNodes = [] } = useQuery<OntologyNode[]>({
    queryKey: ["ontology", projectId],
    queryFn: () => ontologyApi.list(projectId).then((r) => r.data),
    staleTime: 60_000,
  });

  // Per-row custom options added during this session (not persisted to template)
  const [customOpts, setCustomOpts] = React.useState<Record<string, string[]>>({});
  const [customInput, setCustomInput] = React.useState<Record<string, string>>({});

  function addCustomOption(rowId: string) {
    const val = (customInput[rowId] ?? "").trim();
    if (!val) return;
    setCustomOpts((prev) => ({ ...prev, [rowId]: [...(prev[rowId] ?? []), val] }));
    setCustomInput((prev) => ({ ...prev, [rowId]: "" }));
  }

  function setCellValue(rowId: string, value: string | string[]) {
    setForm((f) => ({
      ...f,
      table: { ...f.table, [rowId]: value },
    }));
  }

  function getCellValue(rowId: string): string | string[] {
    return form.table?.[rowId] ?? "";
  }

  const th: React.CSSProperties = {
    padding: "0.4rem 0.6rem",
    background: "#f1f3f4",
    fontWeight: 700,
    fontSize: "0.73rem",
    color: "#5f6368",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    borderBottom: "1px solid #dadce0",
    textAlign: "left",
  };

  const td: React.CSSProperties = {
    padding: "0.35rem 0.6rem",
    borderBottom: "1px solid #f1f3f4",
    verticalAlign: "top",
    fontSize: "0.85rem",
  };

  return (
    <div>
      {/* ── Structured extraction table ── */}
      {templateRows.length > 0 ? (
        <div style={{ marginBottom: "1rem" }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: "0.78rem",
              color: "#8f3f97",
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: "0.5rem",
            }}
          >
            Extraction Table
          </div>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              border: "1px solid #dadce0",
              borderRadius: "0.375rem",
              overflow: "hidden",
              fontSize: "0.85rem",
            }}
          >
            <thead>
              <tr>
                <th style={{ ...th, width: "22%" }}>Domain</th>
                <th style={{ ...th, width: "28%" }}>Data Item</th>
                <th style={{ ...th }}>Data Extraction</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Pre-compute rowSpan for each row: >0 = first in group (span count), 0 = continuation
                const domainSpans = templateRows.map((row, i) => {
                  if (i > 0 && templateRows[i - 1].domain === row.domain) return 0;
                  let span = 1;
                  while (i + span < templateRows.length && templateRows[i + span].domain === row.domain) span++;
                  return span;
                });

                return templateRows.map((row, i) => {
                  const val = getCellValue(row.id);
                  const span = domainSpans[i];
                  const isGroupStart = span > 0;
                  const isLastInGroup = i === templateRows.length - 1 || domainSpans[i + 1] > 0;
                  const rowBorder = isLastInGroup ? "1px solid #dadce0" : "1px solid #f1f3f4";

                  // Linked labels and concepts for this row
                  const linkedLabels = (row.linked_label_ids ?? []).map((id) => allLabels.find((l) => l.id === id)).filter(Boolean) as ProjectLabel[];
                  const linkedNodes = (row.linked_node_ids ?? []).map((id) => allNodes.find((n) => n.id === id)).filter(Boolean) as OntologyNode[];
                  const hasLinks = linkedLabels.length > 0 || linkedNodes.length > 0;

                  // Merged options = template options + custom options added this session
                  const extraOpts = customOpts[row.id] ?? [];
                  const allOpts = [...row.options, ...extraOpts];

                  return (
                    <tr key={row.id}>
                      {isGroupStart && (
                        <td
                          rowSpan={span}
                          style={{
                            ...td,
                            color: "#5f6368",
                            fontWeight: 600,
                            verticalAlign: "middle",
                            background: "#f9fafb",
                            borderRight: "1px solid #e0e0e0",
                            borderBottom: "1px solid #dadce0",
                          }}
                        >
                          {row.domain || <em style={{ color: "#bbb" }}>—</em>}
                        </td>
                      )}
                      <td style={{ ...td, color: "#3c4043", borderBottom: rowBorder }}>
                        <div>{row.item || <em style={{ color: "#bbb" }}>—</em>}</div>
                        {/* Linked labels/concepts as reference badges */}
                        {hasLinks && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                            {linkedLabels.map((lbl) => (
                              <span key={lbl.id} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, background: lbl.color + "22", color: lbl.color, border: `1px solid ${lbl.color}` }}>{lbl.name}</span>
                            ))}
                            {linkedNodes.map((node) => {
                              const color = node.color ?? (node.namespace === "thematic" ? "#7c3aed" : "#3b82f6");
                              return <span key={node.id} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: color + "18", color, border: `1px solid ${color}` }}>{node.name}</span>;
                            })}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, borderBottom: rowBorder }}>
                        {row.type === "string" && (
                          <textarea
                            value={String(val)}
                            onChange={(e) => setCellValue(row.id, e.target.value)}
                            rows={2}
                            placeholder="Enter value…"
                            style={{ width: "100%", boxSizing: "border-box", fontSize: "0.84rem", fontFamily: "inherit", border: "1px solid #e0e0e0", borderRadius: "0.25rem", padding: "0.25rem 0.4rem", resize: "vertical", background: "#fafafa" }}
                          />
                        )}

                        {row.type === "single_select" && (
                          <div>
                            <select
                              value={String(val)}
                              onChange={(e) => setCellValue(row.id, e.target.value)}
                              style={{ fontSize: "0.84rem", padding: "0.28rem 0.45rem", border: "1px solid #e0e0e0", borderRadius: "0.25rem", background: "#fafafa", width: "100%" }}
                            >
                              <option value="">— select —</option>
                              {allOpts.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                            {row.allow_custom_options && (
                              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                                <input
                                  value={customInput[row.id] ?? ""}
                                  onChange={(e) => setCustomInput((p) => ({ ...p, [row.id]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") addCustomOption(row.id); }}
                                  placeholder="+ custom option…"
                                  style={{ fontSize: "0.77rem", padding: "0.18rem 0.4rem", border: "1px dashed #d1d5db", borderRadius: "0.25rem", flex: 1, outline: "none" }}
                                />
                                <button type="button" onClick={() => addCustomOption(row.id)}
                                  style={{ fontSize: "0.72rem", padding: "0.18rem 0.5rem", borderRadius: "0.25rem", border: "none", background: "#6366f1", color: "#fff", cursor: "pointer" }}>
                                  Add
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {row.type === "multi_select" && (
                          <div>
                            <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                              {allOpts.map((opt) => {
                                const selected = Array.isArray(val) ? val.includes(opt) : false;
                                return (
                                  <button key={opt} type="button"
                                    onClick={() => {
                                      const current = Array.isArray(val) ? val : [];
                                      setCellValue(row.id, selected ? current.filter((v) => v !== opt) : [...current, opt]);
                                    }}
                                    style={{ padding: "0.2rem 0.6rem", borderRadius: "1rem", border: `2px solid ${selected ? "#8f3f97" : "#dadce0"}`, background: selected ? "#f3e5f5" : "#f8f9fa", color: selected ? "#8f3f97" : "#5f6368", fontWeight: selected ? 600 : 400, fontSize: "0.8rem", cursor: "pointer" }}
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                            {row.allow_custom_options && (
                              <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                                <input
                                  value={customInput[row.id] ?? ""}
                                  onChange={(e) => setCustomInput((p) => ({ ...p, [row.id]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") addCustomOption(row.id); }}
                                  placeholder="+ custom option…"
                                  style={{ fontSize: "0.77rem", padding: "0.18rem 0.4rem", border: "1px dashed #d1d5db", borderRadius: "0.25rem", flex: 1, outline: "none" }}
                                />
                                <button type="button" onClick={() => addCustomOption(row.id)}
                                  style={{ fontSize: "0.72rem", padding: "0.18rem 0.5rem", borderRadius: "0.25rem", border: "none", background: "#6366f1", color: "#fff", cursor: "pointer" }}>
                                  Add
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      ) : (
        /* No template yet — show a prompt */
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.65rem 0.9rem",
            background: "#fffde7",
            border: "1px solid #fdd835",
            borderRadius: "0.375rem",
            fontSize: "0.82rem",
            color: "#795548",
          }}
        >
          No extraction template defined.{" "}
          <Link
            to={`/projects/${projectId}`}
            style={{ color: "#1a73e8", fontWeight: 600 }}
          >
            Set one up in the project overview →
          </Link>
        </div>
      )}

      {/* ── Free note ── always shown */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>Free note</div>
        <textarea
          value={form.free_note}
          onChange={(e) => setForm((f) => ({ ...f, free_note: e.target.value }))}
          rows={3}
          placeholder="General notes about this paper…"
          style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit" }}
        />
      </div>

      {/* ── Framework novelty toggle ── drives saturation counter */}
      <div style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: 8, border: `1px solid ${form.framework_updated ? "#a5b4fc" : "#e5e7eb"}`, background: form.framework_updated ? "#eef2ff" : "#f9fafb" }}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={!!form.framework_updated}
            onChange={(e) => setForm((f) => ({ ...f, framework_updated: e.target.checked, framework_update_note: e.target.checked ? f.framework_update_note : "" }))}
            style={{ marginTop: 3, accentColor: "#6366f1", width: 15, height: 15, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontSize: "0.85rem", fontWeight: 600, color: form.framework_updated ? "#4338ca" : "#6b7280" }}>
              ✨ This paper introduced new framework concepts
            </div>
            <div style={{ fontSize: "0.76rem", color: "#9ca3af", marginTop: 2 }}>
              Check if you added new categories, codes, or themes not seen in previous papers. Uncheck if everything confirmed existing concepts.
            </div>
          </div>
        </label>
        {form.framework_updated && (
          <textarea
            value={form.framework_update_note ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, framework_update_note: e.target.value }))}
            placeholder="Briefly describe what was new (optional)…"
            rows={2}
            style={{ marginTop: "0.5rem", width: "100%", boxSizing: "border-box", fontSize: "0.8rem", fontFamily: "inherit", border: "1px solid #c7d2fe", borderRadius: "0.375rem", padding: "0.3rem 0.5rem", background: "#fff", resize: "vertical", outline: "none" }}
          />
        )}
      </div>

      <SaturationBadge projectId={projectId} source={source} />

      {isError && <p style={{ color: "#c5221f", marginBottom: "0.5rem" }}>Failed to save extraction. Try again.</p>}

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button className="btn-primary" onClick={onSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button className="btn-secondary" onClick={onSkip} disabled={isPending} title="Skip — come back later">
          Skip
        </button>
        {onGoBack && (
          <button
            onClick={onGoBack}
            disabled={isPending}
            title="Go back to the previous article you extracted"
            style={{
              marginLeft: "auto",
              fontSize: "0.78rem",
              fontWeight: 600,
              padding: "0.25rem 0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid #d1d5db",
              background: "#fff",
              color: "#374151",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            ← Previous extraction
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MixedPanel
// ---------------------------------------------------------------------------

function MixedPanel({
  projectId,
  source,
  autoAdvanceFT,
  autoAdvanceExtract,
  levels,
  onDecision,
  randomize = false,
  seed,
}: {
  projectId: string;
  source: string;
  autoAdvanceFT: boolean;
  autoAdvanceExtract: boolean;
  levels: string[];
  onDecision?: (entry: TimingEntry) => void;
  randomize?: boolean;
  seed?: number;
}) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [taSubmitted, setTaSubmitted] = useState(false);
  const [phase, setPhase] = useState<"ta" | "ft" | "extraction">("ta");
  const [form, setForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);

  // Queue-position-based persistent history navigation.
  const [displayPos, setDisplayPos] = useState<number | null>(null);
  const [maxPos, setMaxPos] = useState<number | null>(null);
  const [queueTotal, setQueueTotal] = useState<number | null>(null);
  const [queueSeed, setQueueSeed] = useState<number | null>(null);
  const [browseItem, setBrowseItem] = useState<ScreeningNextItem | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseForm, setBrowseForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);
  const [browseSaving, setBrowseSaving] = useState(false);
  const [browseSaveError, setBrowseSaveError] = useState(false);
  const [browsePdfOpen, setBrowsePdfOpen] = useState(false);
  const isBrowsingHistory = browseItem !== null;

  const [pdfOpen, setPdfOpen] = useState(false);
  const [showQueueNav, setShowQueueNav] = useState(false);
  const [showOverrideTA, setShowOverrideTA] = useState(false);

  const itemStartedAt = useRef<number>(Date.now());

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setTaSubmitted(false);
    setPhase("ta");
    setForm(EMPTY_EXTRACTION);
    setBrowseItem(null);
    setBrowsePdfOpen(false);
    try {
      const res = await screeningApi.nextItem(projectId, { source_id: source, mode: "mixed", strategy: "mixed", randomize: randomize || undefined, seed: seed });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
        itemStartedAt.current = Date.now();
        const d = res.data;
        if (d.ft_decision) {
          setPhase("extraction");
        } else if (d.ta_decision === "include") {
          setPhase("ft");
          setTaSubmitted(true);
        }
        if (d.queue_position != null) {
          setDisplayPos(d.queue_position);
          setMaxPos(d.queue_position);
          setQueueTotal(d.queue_total ?? null);
          setQueueSeed(d.queue_seed ?? null);
        }
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error?.message ?? "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source, randomize, seed]);

  useEffect(() => { fetchNext(); }, [fetchNext]);

  async function navigateToPos(pos: number) {
    if (pos < 1 || maxPos === null || pos > maxPos) return;
    if (pos === maxPos) {
      setBrowseItem(null);
      setDisplayPos(pos);
      itemStartedAt.current = Date.now();
      return;
    }
    setBrowseLoading(true);
    setBrowsePdfOpen(false);
    try {
      const res = await screeningApi.getQueueSlot(projectId, { source, stage: "mixed", position: pos });
      setBrowseItem(res.data);
      setDisplayPos(pos);
      // Load existing extraction when this item reached extraction stage
      const slot = res.data;
      if (slot.ft_decision === "include") {
        try {
          const exRes = await screeningApi.getItemExtraction(projectId, {
            record_id: slot.record_id ?? null,
            cluster_id: slot.cluster_id ?? null,
          });
          const existing = exRes.data[0];
          setBrowseForm(existing ? (existing.extracted_json as ExtractionJson) : EMPTY_EXTRACTION);
        } catch {
          setBrowseForm(EMPTY_EXTRACTION);
        }
      }
    } catch { /* stay on current */ } finally {
      setBrowseLoading(false);
    }
  }

  async function goToPrev() {
    if (displayPos !== null && displayPos > 1) await navigateToPos(displayPos - 1);
  }
  async function goToNext() {
    if (displayPos !== null && maxPos !== null && displayPos < maxPos) await navigateToPos(displayPos + 1);
    else await fetchNext();
  }

  const decideMutation = useMutation({
    mutationFn: (body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      strategy: string;
    }) => screeningApi.submitDecision(projectId, body),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { record_id?: string | null; cluster_id?: string | null; extracted_json: ExtractionJson }) =>
      screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saturation", projectId] });
      fetchNext();
    },
  });

  const browseDecideMutation = useMutation({
    mutationFn: (body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      strategy: string;
    }) => screeningApi.submitDecision(projectId, body),
    onSuccess: async () => {
      if (displayPos !== null && displayPos !== maxPos) {
        setBrowseLoading(true);
        try {
          const res = await screeningApi.getQueueSlot(projectId, { source, stage: "mixed", position: displayPos });
          setBrowseItem(res.data);
        } finally {
          setBrowseLoading(false);
        }
      }
      queryClient.invalidateQueries({ queryKey: ["queue-list", projectId] });
    },
  });

  const nav = maxPos !== null ? (
    <HistoryNav currentPos={displayPos ?? 1} maxPos={maxPos} onPrev={goToPrev} onNext={goToNext} isFetching={loading || browseLoading}
      onToggleList={() => setShowQueueNav((v) => !v)} listOpen={showQueueNav} />
  ) : null;

  if (loading && maxPos === null) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError && !isBrowsingHistory) return <>{nav}<ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} /></>;
  if (!isBrowsingHistory && (!item || item.done)) return <>{nav}<DoneCard bucketLabel="Mixed Screening" projectId={projectId} /></>;

  // ── History browse view (editable decisions + extraction) ──
  function toggleBrowseChip(field: "levels" | "dimensions", value: string) {
    setBrowseForm((f) => { const arr = f[field]; return { ...f, [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] }; });
  }

  if (isBrowsingHistory && browseItem) {
    return (
      <div>
        {nav}
        {showQueueNav && (
          <QueueNavigatorPanel projectId={projectId} source={source} stage="mixed"
            currentPos={displayPos} onNavigate={(pos) => { navigateToPos(pos); }}
            onClose={() => setShowQueueNav(false)} />
        )}
        {browseLoading && <div style={{ fontSize: "0.78rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Loading…</div>}
        <div style={{ background: "#fefce8", border: "1px solid #fde68a", borderRadius: "0.375rem", padding: "0.4rem 0.85rem", marginBottom: "0.5rem", fontSize: "0.78rem", color: "#92400e", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Viewing session history{browseItem.ft_decision === "include" ? " — you can edit the extraction below" : ""}</span>
          <button onClick={() => maxPos !== null && navigateToPos(maxPos)} style={{ background: "none", border: "none", color: "#92400e", fontWeight: 600, cursor: "pointer", fontSize: "0.78rem", padding: 0 }}>
            Return to current →
          </button>
        </div>
        <PaperCard item={browseItem} projectId={projectId} showAnnotations />
        <PDFFetchButton projectId={projectId} item={browseItem} />
        <PDFUploadPanel projectId={projectId} item={browseItem} />
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.4rem", marginBottom: "0.5rem" }}>
          <button
            onClick={() => setBrowsePdfOpen((v) => !v)}
            style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: browsePdfOpen ? "#4f46e5" : "#fff", color: browsePdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
          >
            📄 {browsePdfOpen ? "Hide PDF" : "View PDF"}
          </button>
        </div>
        {browsePdfOpen && <PDFViewerPanel projectId={projectId} item={browseItem} onClose={() => setBrowsePdfOpen(false)} />}
        <HistoryDecisionPanel
          item={browseItem}
          onDecide={(s, d, reason) =>
            browseDecideMutation.mutate({
              record_id: browseItem.record_id ?? null,
              cluster_id: browseItem.cluster_id ?? null,
              stage: s, decision: d, reason_code: reason, strategy: "mixed",
            })
          }
          isPending={browseDecideMutation.isPending}
        />
        {browseItem.ft_decision === "include" && (
          <div style={{ marginTop: "0.75rem" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#8f3f97", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>
              Edit Extraction
            </div>
            <ExtractionForm
              projectId={projectId} source={source} form={browseForm} setForm={setBrowseForm} levels={levels}
              onSave={async () => {
                setBrowseSaving(true);
                setBrowseSaveError(false);
                try {
                  await screeningApi.submitExtraction(projectId, {
                    record_id: browseItem.record_id ?? null,
                    cluster_id: browseItem.cluster_id ?? null,
                    extracted_json: browseForm,
                  });
                  queryClient.invalidateQueries({ queryKey: ["saturation", projectId] });
                } catch {
                  setBrowseSaveError(true);
                } finally {
                  setBrowseSaving(false);
                }
              }}
              onSkip={() => maxPos !== null && navigateToPos(maxPos)}
              isPending={browseSaving} isError={browseSaveError} toggleChip={toggleBrowseChip}
            />
          </div>
        )}
      </div>
    );
  }

  if (!item) return nav;

  const showFT = phase === "ft" || phase === "extraction" || taSubmitted || item.ta_decision === "include";

  async function handleTAInclude() {
    const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
    try {
      await screeningApi.submitDecision(projectId, {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "TA",
        decision: "include",
        strategy: "mixed",
      });
      onDecision?.({ record_id: item!.record_id, cluster_id: item!.cluster_id, title: item!.title ?? "(unknown)", stage: "TA", decision: "include", decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
      setTaSubmitted(true);
      if (autoAdvanceFT) setPhase("ft");
    } catch { /* shown via mutation error */ }
  }

  function handleTAExclude(reason_code?: string) {
    const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
    decideMutation.mutate(
      { record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, stage: "TA", decision: "exclude", reason_code, strategy: "mixed" },
      {
        onSuccess: () => {
          onDecision?.({ record_id: item!.record_id, cluster_id: item!.cluster_id, title: item!.title ?? "(unknown)", stage: "TA", decision: "exclude", reason_code, decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
          fetchNext();
        },
      }
    );
  }

  function handleFT(decision: "include" | "exclude", reason_code?: string) {
    const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
    decideMutation.mutate(
      { record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, stage: "FT", decision, reason_code, strategy: "mixed" },
      {
        onSuccess: () => {
          onDecision?.({ record_id: item!.record_id, cluster_id: item!.cluster_id, title: item!.title ?? "(unknown)", stage: "FT", decision, reason_code, decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
          if (decision === "include" && autoAdvanceExtract) setPhase("extraction");
          else fetchNext();
        },
      }
    );
  }

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => { const arr = f[field]; return { ...f, [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] }; });
  }

  return (
    <div>
      {nav}

      {/* Session paper list — inline collapsible below nav bar */}
      {showQueueNav && (
        <QueueNavigatorPanel projectId={projectId} source={source} stage="mixed"
          currentPos={displayPos} onNavigate={(pos) => { navigateToPos(pos); }}
          onClose={() => setShowQueueNav(false)} />
      )}

      <ProgressBar remaining={item.remaining} queuePosition={displayPos ?? item.queue_position} queueTotal={queueTotal ?? item.queue_total} queueSeed={queueSeed ?? item.queue_seed} sessionMax={maxPos} />
      <PaperCard item={item} projectId={projectId} showAnnotations />

      {!showFT && (
        <DecisionBar stage="TA" includeLabel={autoAdvanceFT ? "✓ Include — review full text" : "✓ Include"}
          onInclude={handleTAInclude} onExclude={handleTAExclude} onSkip={fetchNext}
          isPending={decideMutation.isPending} isLoading={loading} isError={decideMutation.isError} />
      )}

      {showFT && phase !== "extraction" && (
        <>
          <PDFFetchButton projectId={projectId} item={item} />
          <PDFUploadPanel projectId={projectId} item={item} />
          <div style={{ marginTop: "0.35rem", marginBottom: "0.1rem" }}>
            <button
              onClick={() => setPdfOpen((v) => !v)}
              style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: pdfOpen ? "#4f46e5" : "#fff", color: pdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
            >
              📄 {pdfOpen ? "Hide PDF" : "View PDF"}
            </button>
          </div>
          <DecisionBar stage="FT" includeLabel={autoAdvanceExtract ? "✓ Include — extract data" : "✓ Include"}
            onInclude={() => handleFT("include")} onExclude={(reason) => handleFT("exclude", reason)} onSkip={fetchNext}
            isPending={decideMutation.isPending} isLoading={loading} isError={decideMutation.isError} />

          {/* Override TA decision while at FT stage */}
          <div style={{ marginTop: "0.4rem" }}>
            <button
              onClick={() => setShowOverrideTA((v) => !v)}
              style={{ fontSize: "0.75rem", padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #fde68a", background: showOverrideTA ? "#fef9c3" : "#fff", color: "#92400e", cursor: "pointer", fontWeight: 500 }}
            >
              ↩ Override abstract (TA) decision
            </button>
            {showOverrideTA && (
              <div style={{ marginTop: "0.4rem", padding: "0.6rem 0.85rem", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "0.375rem" }}>
                <div style={{ fontSize: "0.75rem", color: "#92400e", marginBottom: "0.4rem" }}>
                  Submit a TA-level decision for this paper (overrides the existing abstract decision):
                </div>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
                  <button
                    disabled={decideMutation.isPending}
                    onClick={() => {
                      decideMutation.mutate(
                        { record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, stage: "TA", decision: "include", strategy: "mixed" },
                        { onSuccess: () => { setShowOverrideTA(false); fetchNext(); } }
                      );
                    }}
                    style={{ padding: "0.2rem 0.7rem", borderRadius: "0.375rem", border: "1px solid #34a853", background: "#e6f4ea", color: "#188038", fontWeight: 600, cursor: "pointer", fontSize: "0.8rem" }}
                  >
                    ✓ TA Include
                  </button>
                </div>
                <ExcludeControls
                  onExclude={(reason) => {
                    decideMutation.mutate(
                      { record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, stage: "TA", decision: "exclude", reason_code: reason, strategy: "mixed" },
                      { onSuccess: () => { setShowOverrideTA(false); fetchNext(); } }
                    );
                  }}
                  disabled={decideMutation.isPending}
                />
              </div>
            )}
          </div>
        </>
      )}

      {phase === "extraction" && (
        <div style={{ marginTop: "0.5rem" }}>
          {/* PDF access in extraction stage */}
          <PDFFetchButton projectId={projectId} item={item!} />
          <PDFUploadPanel projectId={projectId} item={item!} />

          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.5rem", marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#8f3f97", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Extract Data
            </div>
            <button
              onClick={() => setPdfOpen((v) => !v)}
              style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: pdfOpen ? "#4f46e5" : "#fff", color: pdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
            >
              📄 {pdfOpen ? "Hide PDF" : "View PDF"}
            </button>
            <button
              onClick={() => {
                if (!window.confirm("Exclude this paper at Full-Text stage and return to screening?")) return;
                handleFT("exclude");
              }}
              disabled={decideMutation.isPending}
              style={{ marginLeft: "auto", fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #fca5a5", background: "#fff", color: "#991b1b", cursor: "pointer" }}
            >
              ✕ Exclude at FT
            </button>
          </div>
          <ExtractionForm
            projectId={projectId} source={source} form={form} setForm={setForm} levels={levels}
            onSave={() => {
              const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
              onDecision?.({ record_id: item!.record_id, cluster_id: item!.cluster_id, title: item!.title ?? "(unknown)", stage: "extract", decision: "save", decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
              saveMutation.mutate({ record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, extracted_json: form });
            }}
            onGoBack={displayPos !== null && displayPos > 1 ? goToPrev : undefined}
            onSkip={fetchNext} isPending={saveMutation.isPending} isError={saveMutation.isError} toggleChip={toggleChip}
          />
        </div>
      )}

      {pdfOpen && item && <PDFViewerPanel projectId={projectId} item={item} onClose={() => setPdfOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExtractionPanel
// ---------------------------------------------------------------------------

function ExtractionPanel({
  projectId,
  source,
  strategy,
  levels,
  onDecision,
  randomize = false,
  seed,
}: {
  projectId: string;
  source: string;
  strategy: string;
  levels: string[];
  onDecision?: (entry: TimingEntry) => void;
  randomize?: boolean;
  seed?: number;
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Queue-position-based persistent history navigation.
  const [displayPos, setDisplayPos] = useState<number | null>(null);
  const [maxPos, setMaxPos] = useState<number | null>(null);
  const [queueTotal, setQueueTotal] = useState<number | null>(null);
  const [queueSeed, setQueueSeed] = useState<number | null>(null);
  const [browseItem, setBrowseItem] = useState<ScreeningNextItem | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseForm, setBrowseForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);
  const [browseSaving, setBrowseSaving] = useState(false);
  const [browseSaveError, setBrowseSaveError] = useState(false);
  const [browsePdfOpen, setBrowsePdfOpen] = useState(false);
  const isBrowsingHistory = browseItem !== null;

  const [pdfOpen, setPdfOpen] = useState(false);

  const itemStartedAt = useRef<number>(Date.now());

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setBrowseItem(null);
    setBrowsePdfOpen(false);
    try {
      const res = await screeningApi.nextItem(projectId, { source_id: source, mode: "extract", strategy, bucket: "extract_pending", randomize: randomize || undefined, seed: seed });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
        setForm(EMPTY_EXTRACTION);
        itemStartedAt.current = Date.now();
        const d = res.data;
        if (d.queue_position != null) {
          setDisplayPos(d.queue_position);
          setMaxPos(d.queue_position);
          setQueueTotal(d.queue_total ?? null);
          setQueueSeed(d.queue_seed ?? null);
        }
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error?.message ?? "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source, strategy]);

  useEffect(() => { fetchNext(); }, [fetchNext]);

  async function navigateToPos(pos: number) {
    if (pos < 1 || maxPos === null || pos > maxPos) return;
    if (pos === maxPos) {
      setBrowseItem(null);
      setDisplayPos(pos);
      itemStartedAt.current = Date.now();
      return;
    }
    setBrowseLoading(true);
    setBrowsePdfOpen(false);
    try {
      const res = await screeningApi.getQueueSlot(projectId, { source, stage: "extract", position: pos });
      setBrowseItem(res.data);
      setDisplayPos(pos);
      // Load existing extraction for the history item
      const slot = res.data;
      try {
        const exRes = await screeningApi.getItemExtraction(projectId, {
          record_id: slot.record_id ?? null,
          cluster_id: slot.cluster_id ?? null,
        });
        const existing = exRes.data[0];
        setBrowseForm(existing ? (existing.extracted_json as ExtractionJson) : EMPTY_EXTRACTION);
      } catch {
        setBrowseForm(EMPTY_EXTRACTION);
      }
    } catch { /* stay on current */ } finally {
      setBrowseLoading(false);
    }
  }

  async function goToPrev() {
    if (displayPos !== null && displayPos > 1) await navigateToPos(displayPos - 1);
  }
  async function goToNext() {
    if (displayPos !== null && maxPos !== null && displayPos < maxPos) await navigateToPos(displayPos + 1);
    else await fetchNext();
  }

  const extractionQc = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: (payload: { record_id?: string | null; cluster_id?: string | null; extracted_json: ExtractionJson }) =>
      screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => {
      extractionQc.invalidateQueries({ queryKey: ["saturation", projectId] });
      fetchNext();
    },
  });

  const ftExcludeMutation = useMutation({
    mutationFn: (body: { record_id?: string | null; cluster_id?: string | null; reason_code?: string }) =>
      screeningApi.submitDecision(projectId, { ...body, stage: "FT", decision: "exclude", strategy }),
    onSuccess: () => fetchNext(),
  });

  const nav = maxPos !== null ? (
    <HistoryNav currentPos={displayPos ?? 1} maxPos={maxPos} onPrev={goToPrev} onNext={goToNext} isFetching={loading || browseLoading} />
  ) : null;

  if (loading && maxPos === null) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError && !isBrowsingHistory) return <>{nav}<ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} /></>;
  if (!isBrowsingHistory && (!item || item.done)) return <>{nav}<DoneCard bucketLabel="Extract Data" projectId={projectId} /></>;

  // ── History browse view — show paper info + editable extraction form ──
  function toggleBrowseChip(field: "levels" | "dimensions", value: string) {
    setBrowseForm((f) => { const arr = f[field]; return { ...f, [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] }; });
  }

  if (isBrowsingHistory && browseItem) {
    return (
      <div>
        {nav}
        {browseLoading && <div style={{ fontSize: "0.78rem", color: "#9ca3af", marginBottom: "0.4rem" }}>Loading…</div>}
        <div style={{ background: "#fefce8", border: "1px solid #fde68a", borderRadius: "0.375rem", padding: "0.4rem 0.85rem", marginBottom: "0.5rem", fontSize: "0.78rem", color: "#92400e", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Viewing session history — you can edit the extraction below</span>
          <button onClick={() => maxPos !== null && navigateToPos(maxPos)} style={{ background: "none", border: "none", color: "#92400e", fontWeight: 600, cursor: "pointer", fontSize: "0.78rem", padding: 0 }}>
            Return to current →
          </button>
        </div>
        <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "0.85rem 1.1rem", marginBottom: "1rem", background: "#fff" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{browseItem.title ?? <em style={{ color: "#888" }}>No title</em>}</div>
          <div style={{ fontSize: "0.82rem", color: "#5f6368", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {browseItem.year && <span>{browseItem.year}</span>}
            {(browseItem.source_names ?? []).map((s) => (
              <span key={s} style={{ background: "#e8f0fe", color: "#1a73e8", borderRadius: "1rem", padding: "0 0.45rem", fontSize: "0.75rem" }}>{s}</span>
            ))}
          </div>
          {browseItem.abstract && (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", lineHeight: 1.6, color: "#3c4043" }}>{browseItem.abstract}</p>
          )}
        </div>
        <PDFFetchButton projectId={projectId} item={browseItem} />
        <PDFUploadPanel projectId={projectId} item={browseItem} />
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.4rem", marginBottom: "0.5rem" }}>
          <button
            onClick={() => setBrowsePdfOpen((v) => !v)}
            style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: browsePdfOpen ? "#4f46e5" : "#fff", color: browsePdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
          >
            📄 {browsePdfOpen ? "Hide PDF" : "View PDF"}
          </button>
        </div>
        {browsePdfOpen && <PDFViewerPanel projectId={projectId} item={browseItem} onClose={() => setBrowsePdfOpen(false)} />}
        <ExtractionForm
          projectId={projectId} source={source} form={browseForm} setForm={setBrowseForm} levels={levels}
          onSave={async () => {
            setBrowseSaving(true);
            setBrowseSaveError(false);
            try {
              await screeningApi.submitExtraction(projectId, {
                record_id: browseItem.record_id ?? null,
                cluster_id: browseItem.cluster_id ?? null,
                extracted_json: browseForm,
              });
              extractionQc.invalidateQueries({ queryKey: ["saturation", projectId] });
            } catch {
              setBrowseSaveError(true);
            } finally {
              setBrowseSaving(false);
            }
          }}
          onSkip={() => maxPos !== null && navigateToPos(maxPos)}
          isPending={browseSaving} isError={browseSaveError} toggleChip={toggleBrowseChip}
        />
      </div>
    );
  }

  if (!item) return nav;

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => { const arr = f[field]; return { ...f, [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] }; });
  }

  return (
    <div>
      {nav}
      <ProgressBar remaining={item.remaining} queuePosition={displayPos ?? item.queue_position} queueTotal={queueTotal ?? item.queue_total} queueSeed={queueSeed ?? item.queue_seed} sessionMax={maxPos} />
      <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "0.85rem 1.1rem", marginBottom: "1rem", background: "#fff" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{item.title ?? <em style={{ color: "#888" }}>No title</em>}</div>
        <div style={{ fontSize: "0.82rem", color: "#5f6368", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          {item.year && <span>{item.year}</span>}
          {(item.source_names ?? []).map((s) => (
            <span key={s} style={{ background: "#e8f0fe", color: "#1a73e8", borderRadius: "1rem", padding: "0 0.45rem", fontSize: "0.75rem" }}>{s}</span>
          ))}
        </div>
        <AnnotationsPanel projectId={projectId} item={item} />
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <LabelPicker projectId={projectId} recordId={item.record_id} clusterId={item.cluster_id} />
          <ConceptPicker projectId={projectId} recordId={item.record_id} clusterId={item.cluster_id} />
        </div>
      </div>
      {/* PDF access in extraction stage */}
      <PDFFetchButton projectId={projectId} item={item} />
      <PDFUploadPanel projectId={projectId} item={item} />

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.4rem", marginBottom: "0.5rem" }}>
        <button
          onClick={() => setPdfOpen((v) => !v)}
          style={{ fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #c7d7fd", background: pdfOpen ? "#4f46e5" : "#fff", color: pdfOpen ? "#fff" : "#1558d6", cursor: "pointer" }}
        >
          📄 {pdfOpen ? "Hide PDF" : "View PDF"}
        </button>
        <button
          onClick={() => {
            if (!window.confirm("Exclude this paper at Full-Text stage and move to the next?")) return;
            ftExcludeMutation.mutate({ record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null });
          }}
          disabled={ftExcludeMutation.isPending}
          style={{ marginLeft: "auto", fontSize: "0.75rem", fontWeight: 600, padding: "0.18rem 0.65rem", borderRadius: "1rem", border: "1px solid #fca5a5", background: "#fff", color: "#991b1b", cursor: "pointer" }}
        >
          ✕ Exclude at FT
        </button>
      </div>
      <ExtractionForm
        projectId={projectId} source={source} form={form} setForm={setForm} levels={levels}
        onSave={() => {
          const timeSpent = Math.round((Date.now() - itemStartedAt.current) / 1000);
          onDecision?.({ record_id: item!.record_id, cluster_id: item!.cluster_id, title: item!.title ?? "(unknown)", stage: "extract", decision: "save", decided_at: new Date().toISOString(), time_spent_seconds: timeSpent });
          saveMutation.mutate({ record_id: item!.record_id ?? null, cluster_id: item!.cluster_id ?? null, extracted_json: form });
        }}
        onGoBack={displayPos !== null && displayPos > 1 ? goToPrev : undefined}
        onSkip={fetchNext} isPending={saveMutation.isPending} isError={saveMutation.isError} toggleChip={toggleChip}
      />
      {pdfOpen && item && <PDFViewerPanel projectId={projectId} item={item} onClose={() => setPdfOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueueSidebar
// ---------------------------------------------------------------------------

function QueueSidebar({
  projectId,
  currentBucket,
  strategy,
  source,
}: {
  projectId: string;
  currentBucket: string;
  strategy: string;
  source: string;
}) {
  const navigate = useNavigate();

  const { data: sources = [] } = useQuery<ScreeningSource[]>({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId).then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const agg = sources.find((s) => s.id === "all");
  if (!agg) return <aside style={{ width: 210, flexShrink: 0 }} />;

  const taUnscreened = Math.max(0, agg.record_count - agg.ta_screened);
  const ftPending = Math.max(0, agg.ta_included - agg.ft_screened);
  const extractPending = Math.max(0, agg.ft_included - agg.extracted_count);

  // Completion flags — a stage is "done" when all TA is screened and downstream
  // stages have no pending work (including when all FT-included were excluded = 0 remaining).
  const taDone = agg.record_count > 0 && taUnscreened === 0;
  const ftDone = taDone && ftPending === 0;
  const extractDone = ftDone && extractPending === 0;

  function goToBucket(bucket: string) {
    navigate(`/projects/${projectId}/screen?${new URLSearchParams({ bucket, source, strategy }).toString()}`);
  }

  type SidebarRow =
    | { type: "bucket"; bucket: string; label: string; count: number; accent?: string; done?: boolean }
    | { type: "divider" };

  const rows: SidebarRow[] = [
    { type: "bucket", bucket: "ta_unscreened", label: "Screen (TA)", count: taUnscreened, done: taDone },
    { type: "bucket", bucket: "ta_included", label: "TA Included", count: agg.ta_included, accent: "#188038" },
    { type: "divider" },
    { type: "bucket", bucket: "ft_pending", label: "Full-text Review", count: ftPending, done: ftDone },
    { type: "bucket", bucket: "ft_included", label: "FT Included", count: agg.ft_included, accent: "#188038" },
    { type: "divider" },
    { type: "bucket", bucket: "extract_pending", label: "Extract Data", count: extractPending, done: extractDone },
    { type: "bucket", bucket: "extract_done", label: "Extracted", count: agg.extracted_count, accent: "#188038" },
  ];

  const isExtractBucket = currentBucket === "extract_pending" || currentBucket === "extract_done";

  return (
    <aside style={{ width: 210, flexShrink: 0, position: "sticky", top: "5.5rem", alignSelf: "flex-start" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "0.625rem", overflow: "hidden", fontSize: "0.83rem" }}>
        <div style={{ padding: "0.65rem 0.9rem", background: "#f8f9fa", borderBottom: "1px solid #e5e7eb", fontWeight: 700, fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280" }}>
          Queue Overview
        </div>
        {rows.map((row, i) => {
          if (row.type === "divider") {
            return <div key={`div-${i}`} style={{ height: 1, background: "#f3f4f6", margin: "0.1rem 0" }} />;
          }
          const isActive = currentBucket === row.bucket;
          const hasItems = row.count > 0;
          const isDone = row.done === true;
          return (
            <button key={row.bucket} onClick={() => goToBucket(row.bucket)}
              style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0.9rem", background: isActive ? "#eef3ff" : isDone ? "#f0fdf4" : "transparent", border: "none", borderLeft: isActive ? "3px solid #4f46e5" : isDone ? "3px solid #16a34a" : "3px solid transparent", cursor: "pointer", textAlign: "left", color: isActive ? "#3730a3" : isDone ? "#15803d" : "#374151", fontWeight: isActive || isDone ? 600 : 400, fontSize: "0.82rem" }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = isDone ? "#dcfce7" : "#f9fafb"; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = isDone ? "#f0fdf4" : "transparent"; }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
              {isDone ? (
                <span style={{ marginLeft: "0.4rem", flexShrink: 0, padding: "0.05rem 0.45rem", borderRadius: "1rem", fontSize: "0.73rem", fontWeight: 700, background: "#dcfce7", color: "#15803d" }}>
                  ✓ Done
                </span>
              ) : (
              <span style={{ marginLeft: "0.4rem", flexShrink: 0, padding: "0.05rem 0.45rem", borderRadius: "1rem", fontSize: "0.73rem", fontWeight: 600, background: isActive ? "#c7d2fe" : hasItems ? (row.accent ? "#dcfce7" : "#dbeafe") : "#f3f4f6", color: isActive ? "#3730a3" : hasItems ? (row.accent ? "#166534" : "#1e40af") : "#9ca3af" }}>
                {row.count}
              </span>
              )}
            </button>
          );
        })}
      </div>

      {isExtractBucket && (
        <div style={{ marginTop: "0.75rem" }}>
          <SaturationBadge projectId={projectId} source={source} />
        </div>
      )}

      {/* Per-corpus TA completion dots */}
      {(() => {
        const perSource = sources.filter((s) => s.id !== "all" && s.record_count > 0);
        if (perSource.length === 0) return null;
        return (
          <div style={{ marginTop: "0.75rem", background: "#f8f9fa", border: "1px solid #e5e7eb", borderRadius: "0.375rem", padding: "0.5rem 0.75rem" }}>
            <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.4rem" }}>
              Corpora
            </div>
            {perSource.map((src) => {
              const taDone = src.record_count > 0 && src.ta_screened >= src.record_count;
              const ftDone = taDone && (src.ta_included === 0 || src.ft_screened >= src.ta_included);
              const exDone = ftDone && (src.ft_included === 0 || src.extracted_count >= src.ft_included);
              return (
                <div key={src.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                  <span style={{ fontSize: "0.73rem", color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }} title={src.name}>
                    {src.name}
                  </span>
                  <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    {[
                      { done: taDone, label: "TA" },
                      { done: ftDone, label: "FT" },
                      { done: exDone, label: "EX" },
                    ].map(({ done, label }) => (
                      <span key={label} title={label} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 3, fontSize: "0.6rem", fontWeight: 700, background: done ? "#dcfce7" : "#f3f4f6", color: done ? "#15803d" : "#d1d5db" }}>
                        {done ? "✓" : label[0]}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// SessionLogPanel — export/import timing log
// ---------------------------------------------------------------------------

function SessionLogPanel({
  projectId,
  entries,
  onClear,
}: {
  projectId: string;
  entries: TimingEntry[];
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [importResult, setImportResult] = useState<{ entries: TimingEntry[]; errors: string[] } | null>(null);
  const [importStats, setImportStats] = useState<ReturnType<typeof computeStats> | null>(null);
  const [apiExportLoading, setApiExportLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sessionStats = computeStats(entries);

  function handleExportSession() {
    const csv = entriesToCSVRows(entries);
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(csv, `screening_session_${projectId.slice(0, 8)}_${date}.csv`);
  }

  async function handleExportAllDecisions() {
    setApiExportLoading(true);
    try {
      const res = await screeningApi.listDecisions(projectId);
      const decisions = res.data;
      // Build CSV rows from backend decisions (no time_spent available)
      const header = "id,record_id,cluster_id,stage,decision,reason_code,notes,reviewer_id,created_at";
      const rows = decisions.map((d) =>
        [d.id, d.record_id ?? "", d.cluster_id ?? "", d.stage, d.decision, d.reason_code ?? "", d.notes ?? "", d.reviewer_id ?? "", d.created_at]
          .map((v) => escapeCSVCell(v))
          .join(",")
      );
      const csv = [header, ...rows].join("\n");
      const date = new Date().toISOString().slice(0, 10);
      downloadTextFile(csv, `screening_all_decisions_${projectId.slice(0, 8)}_${date}.csv`);
    } catch {
      alert("Failed to fetch decisions from server.");
    } finally {
      setApiExportLoading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = parseImportedCSV(text);
      setImportResult(result);
      setImportStats(computeStats(result.entries));
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  const fmt = (n: number | null | undefined, unit = "s") =>
    n == null ? "—" : `${n}${unit}`;
  const pct = (a: number, b: number) =>
    b === 0 ? "—" : `${Math.round((a / b) * 100)}%`;

  function StatRow({ label, value }: { label: string; value: string }) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", padding: "0.18rem 0" }}>
        <span style={{ color: "#6b7280" }}>{label}</span>
        <span style={{ fontWeight: 600, color: "#111827" }}>{value}</span>
      </div>
    );
  }

  function StatsBlock({ stats, label }: { stats: ReturnType<typeof computeStats>; label: string }) {
    return (
      <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "0.75rem", marginTop: "0.75rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#4b5563", marginBottom: "0.4rem" }}>
          {label}
        </div>
        <StatRow label="Total decisions" value={String(stats.total)} />
        {stats.ta.count > 0 && (
          <>
            <StatRow label="TA screened" value={String(stats.ta.count)} />
            <StatRow label="TA included" value={`${stats.ta.included} (${pct(stats.ta.included, stats.ta.count)})`} />
            {stats.ta.avgTime && <StatRow label="Avg time / TA" value={fmt(stats.ta.avgTime)} />}
          </>
        )}
        {stats.ft.count > 0 && (
          <>
            <StatRow label="FT screened" value={String(stats.ft.count)} />
            <StatRow label="FT included" value={`${stats.ft.included} (${pct(stats.ft.included, stats.ft.count)})`} />
            {stats.ft.avgTime && <StatRow label="Avg time / FT" value={fmt(stats.ft.avgTime)} />}
          </>
        )}
        {stats.ex.count > 0 && (
          <>
            <StatRow label="Extractions" value={String(stats.ex.count)} />
            {stats.ex.avgTime && <StatRow label="Avg time / extract" value={fmt(stats.ex.avgTime)} />}
          </>
        )}
        {stats.rate && <StatRow label="Rate" value={`~${stats.rate} papers/hr`} />}
        {stats.earliest && (
          <StatRow label="Period" value={`${stats.earliest.toLocaleDateString()} – ${stats.latest?.toLocaleDateString() ?? "?"}`} />
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: "0.75rem", background: "#fff", border: "1px solid #e5e7eb", borderRadius: "0.625rem", overflow: "hidden" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.6rem 0.9rem", background: "#f8f9fa", border: "none", borderBottom: open ? "1px solid #e5e7eb" : "none", cursor: "pointer", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#6b7280" }}
      >
        <span>Session Log {entries.length > 0 ? `· ${entries.length}` : ""}</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0.75rem 0.9rem" }}>
          {/* Session stats */}
          {entries.length > 0 ? (
            <StatsBlock stats={sessionStats} label="This session" />
          ) : (
            <p style={{ fontSize: "0.78rem", color: "#9ca3af", margin: "0.25rem 0 0.5rem" }}>
              No decisions logged yet this session.
            </p>
          )}

          {/* Export buttons */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.75rem" }}>
            <button
              onClick={handleExportSession}
              disabled={entries.length === 0}
              style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem", background: "#eef3ff", border: "1px solid #c7d2fe", borderRadius: "0.375rem", color: "#4f46e5", fontWeight: 600, cursor: entries.length === 0 ? "not-allowed" : "pointer", opacity: entries.length === 0 ? 0.5 : 1, textAlign: "left" }}
            >
              ↓ Export session log (CSV)
            </button>
            <button
              onClick={handleExportAllDecisions}
              disabled={apiExportLoading}
              style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "0.375rem", color: "#166534", fontWeight: 600, cursor: "pointer", textAlign: "left" }}
            >
              {apiExportLoading ? "Fetching…" : "↓ Export all decisions (API)"}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem", background: "#fefce8", border: "1px solid #fde68a", borderRadius: "0.375rem", color: "#92400e", fontWeight: 600, cursor: "pointer", textAlign: "left" }}
            >
              ↑ Import &amp; analyse CSV
            </button>
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleFileChange} />
          </div>

          {/* Clear session */}
          {entries.length > 0 && (
            <button
              onClick={onClear}
              style={{ marginTop: "0.5rem", fontSize: "0.73rem", color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
            >
              Clear session log
            </button>
          )}

          {/* Import results */}
          {importResult && (
            <div style={{ marginTop: "0.75rem" }}>
              {importResult.errors.length > 0 && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "0.375rem", padding: "0.5rem 0.7rem", marginBottom: "0.5rem", fontSize: "0.75rem", color: "#b91c1c" }}>
                  {importResult.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
              {importStats && importStats.total > 0 && (
                <StatsBlock stats={importStats} label={`Imported · ${importResult.entries.length} rows`} />
              )}
              {importResult.entries.length === 0 && importResult.errors.length === 0 && (
                <p style={{ fontSize: "0.78rem", color: "#9ca3af" }}>No valid rows found in file.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StageStep + AutoToggle — header helpers
// ---------------------------------------------------------------------------

function StageStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem", fontWeight: active ? 700 : done ? 500 : 400, color: active ? "#4f46e5" : done ? "#188038" : "#9ca3af" }}>
      <span style={{ width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 700, background: active ? "#4f46e5" : done ? "#188038" : "#e5e7eb", color: active || done ? "#fff" : "#9ca3af", flexShrink: 0 }}>
        {done ? "✓" : active ? "→" : "·"}
      </span>
      {label}
    </div>
  );
}

function AutoToggle({ checked, onChange, label, tooltip }: { checked: boolean; onChange: (v: boolean) => void; label: string; tooltip: string }) {
  return (
    <label title={tooltip}
      style={{ fontSize: "0.8rem", color: checked ? "#4f46e5" : "#6b7280", display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", userSelect: "none", padding: "0.2rem 0.5rem", borderRadius: "0.375rem", border: `1px solid ${checked ? "#c7d2fe" : "#e5e7eb"}`, background: checked ? "#eef3ff" : "#f9fafb", fontWeight: checked ? 600 : 400 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: "#4f46e5", width: 13, height: 13 }} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ScreeningWorkspace() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [criteriaOpen, setCriteriaOpen] = useState(false);

  const bucket = searchParams.get("bucket") ?? "ta_unscreened";
  const legacyMode = searchParams.get("mode");
  const source = searchParams.get("source") ?? "all";
  const strategy = (searchParams.get("strategy") ?? "sequential") as "sequential" | "mixed";
  const seedParam = searchParams.get("seed");
  const seedNum = seedParam ? parseInt(seedParam, 10) : undefined;

  // Persist current screening params so the sidebar link can restore them
  useEffect(() => {
    if (!projectId) return;
    const key = `ep_screening_last_${projectId}`;
    const params = searchParams.toString();
    if (params) localStorage.setItem(key, params);
  }, [projectId, searchParams]);

  const [autoAdvanceFT, setAutoAdvanceFT] = useLocalStorage("autoAdvanceFT", true);
  const [autoAdvanceExtract, setAutoAdvanceExtract] = useLocalStorage("autoAdvanceExtract", true);
  const urlRandomize = searchParams.get("randomize") === "true";
  const [storedRandomize, setRandomize] = useLocalStorage("screeningRandomize", false);
  const randomize = urlRandomize || storedRandomize;

  const { entries: timingEntries, addEntry: addTimingEntry, clearLog: clearTimingLog } =
    useTimingLog(projectId ?? "");

  const { data: projectData } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const criteria = projectData?.criteria ?? { inclusion: [], exclusion: [] };
  const hasCriteria = criteria.inclusion.length > 0 || criteria.exclusion.length > 0;

  const projectLevels =
    (projectData?.criteria?.levels ?? []).length > 0
      ? (projectData!.criteria!.levels as string[])
      : DEFAULT_LEVELS;

  if (!projectId) return null;

  const sourceName = source === "all" ? "All databases" : source;
  const showExtractPanel =
    strategy === "sequential" &&
    (bucket === "extract_pending" || bucket === "extract_done" || legacyMode === "extract");
  const showMixed = strategy === "mixed";
  const isFTBucket = bucket === "ft_pending";

  const stageIndex = showMixed ? -1
    : bucket === "ta_unscreened" || bucket === "ta_included" ? 0
    : bucket === "ft_pending" || bucket === "ft_included" ? 1
    : 2;

  return (
    <div className="page">
      {/* ── Sticky header ── */}
      <header style={{ position: "sticky", top: 0, zIndex: 100, background: "#fff", borderBottom: "1px solid #e5e7eb", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 1.5rem 0.4rem", flexWrap: "wrap" }}>
          <Link to={`/projects/${projectId}`} style={{ fontSize: "0.82rem", color: "#6b7280", textDecoration: "none", display: "flex", alignItems: "center", gap: "0.2rem", flexShrink: 0 }}>
            ← Back
          </Link>
          <div style={{ width: 1, height: 16, background: "#e5e7eb", flexShrink: 0 }} />
          <span style={{ fontSize: "0.8rem", color: "#4f46e5", fontWeight: 600, background: "#eef3ff", borderRadius: "1rem", padding: "0.15rem 0.7rem", border: "1px solid #c7d2fe", flexShrink: 0 }}>
            {sourceName}
          </span>
          {strategy === "mixed" && (
            <span style={{ fontSize: "0.75rem", color: "#7c3aed", fontWeight: 600, background: "#f3e8ff", borderRadius: "1rem", padding: "0.15rem 0.65rem", border: "1px solid #ddd6fe", flexShrink: 0 }}>
              Mixed mode
            </span>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto", flexWrap: "wrap", alignItems: "center" }}>
            {showMixed && (
              <AutoToggle checked={autoAdvanceFT} onChange={setAutoAdvanceFT} label="Auto FT"
                tooltip="When you include a paper at TA stage, automatically advance to full-text review for the same paper." />
            )}
            {(showMixed || isFTBucket) && (
              <AutoToggle checked={autoAdvanceExtract} onChange={setAutoAdvanceExtract} label="Auto Extract"
                tooltip="When you include a paper at full-text stage, automatically open the data extraction form." />
            )}
            <AutoToggle
              checked={randomize}
              onChange={(val: boolean) => {
                setRandomize(val);
                // Also clear/set the URL param so the derived value stays consistent
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  if (val) next.set("randomize", "true");
                  else next.delete("randomize");
                  return next;
                }, { replace: true });
              }}
              label="⇄ Shuffle"
              tooltip="Randomize paper order — useful for minimizing position bias or blinded screening."
            />
          </div>
        </div>

        {/* Stage stepper */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0 1.5rem 0.55rem" }}>
          <StageStep label="Title / Abstract" active={showMixed || stageIndex === 0} done={!showMixed && stageIndex > 0} />
          <span style={{ color: "#d1d5db", fontSize: "0.8rem" }}>›</span>
          <StageStep label="Full Text" active={showMixed || stageIndex === 1} done={!showMixed && stageIndex > 1} />
          <span style={{ color: "#d1d5db", fontSize: "0.8rem" }}>›</span>
          <StageStep label="Extraction" active={showMixed || stageIndex === 2} done={false} />
        </div>
      </header>

      {/* ── Body ── */}
      <div style={{ display: "flex", gap: "1.5rem", maxWidth: 960, margin: "0 auto", padding: "1.5rem 1.25rem 3rem", alignItems: "flex-start" }}>
        {/* Main content */}
        <main style={{ flex: 1, minWidth: 0, maxWidth: 700 }}>
          {hasCriteria && (
            <div style={{ marginBottom: "1rem", border: "1px solid #dadce0", borderRadius: "0.5rem", overflow: "hidden" }}>
              <button onClick={() => setCriteriaOpen((v) => !v)}
                style={{ width: "100%", background: "#f8f9fa", border: "none", borderBottom: criteriaOpen ? "1px solid #dadce0" : "none", padding: "0.6rem 1rem", textAlign: "left", cursor: "pointer", fontSize: "0.85rem", color: "#5f6368", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 500 }}>Criteria reference</span>
                <span>{criteriaOpen ? "▲" : "▼"}</span>
              </button>
              {criteriaOpen && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", padding: "0.9rem 1rem", background: "#fff" }}>
                  <div>
                    <div style={{ color: "#188038", fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.82rem" }}>✓ Include if</div>
                    {criteria.inclusion.map((c) => <div key={c.id} style={{ fontSize: "0.82rem", marginBottom: "0.25rem", color: "#3c4043" }}>• {c.text}</div>)}
                    {criteria.inclusion.length === 0 && <em style={{ fontSize: "0.78rem", color: "#888" }}>None defined</em>}
                  </div>
                  <div>
                    <div style={{ color: "#c5221f", fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.82rem" }}>✕ Exclude if</div>
                    {criteria.exclusion.map((c) => <div key={c.id} style={{ fontSize: "0.82rem", marginBottom: "0.25rem", color: "#3c4043" }}>• {c.text}</div>)}
                    {criteria.exclusion.length === 0 && <em style={{ fontSize: "0.78rem", color: "#888" }}>None defined</em>}
                  </div>
                </div>
              )}
            </div>
          )}

          {showMixed ? (
            <MixedPanel projectId={projectId} source={source} autoAdvanceFT={autoAdvanceFT} autoAdvanceExtract={autoAdvanceExtract} levels={projectLevels} onDecision={addTimingEntry} randomize={randomize} seed={seedNum} />
          ) : showExtractPanel ? (
            <ExtractionPanel projectId={projectId} source={source} strategy={strategy} levels={projectLevels} onDecision={addTimingEntry} randomize={randomize} seed={seedNum} />
          ) : (
            <ScreeningPanel projectId={projectId} bucket={bucket} source={source} strategy={strategy} autoAdvanceExtract={isFTBucket ? autoAdvanceExtract : false} levels={projectLevels} onDecision={addTimingEntry} randomize={randomize} seed={seedNum} />
          )}
        </main>

        {/* Right sidebar: queue overview + session log */}
        <div style={{ width: 210, flexShrink: 0, position: "sticky", top: "5.5rem", alignSelf: "flex-start" }}>
          <QueueSidebar projectId={projectId} currentBucket={showMixed ? "mixed" : bucket} strategy={strategy} source={source} />
          <SessionLogPanel projectId={projectId} entries={timingEntries} onClear={clearTimingLog} />
        </div>
      </div>
    </div>
  );
}