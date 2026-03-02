import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { screeningApi, projectsApi, annotationsApi } from "../api/client";
import type { ExtractionJson, Snippet, ScreeningNextItem } from "../api/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDE_REASONS = [
  { code: "population", label: "Wrong population" },
  { code: "intervention", label: "Wrong intervention / exposure" },
  { code: "outcome", label: "Wrong outcome" },
  { code: "study_design", label: "Wrong study design" },
  { code: "duplicate", label: "Duplicate" },
  { code: "other", label: "Other" },
];

const DEFAULT_LEVELS = [
  "gene", "molecular", "cellular", "tissue/organ",
  "patient/clinical", "population", "societal",
];

const DIMENSIONS = ["objective", "subjective", "societal"];

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
// Shared helper components
// ---------------------------------------------------------------------------

function ProgressBar({ remaining }: { remaining: number | null | undefined }) {
  if (remaining === undefined || remaining === null) return null;
  return (
    <div style={{ fontSize: "0.85rem", color: "#5f6368", marginBottom: "0.5rem" }}>
      {remaining} remaining
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
  const [selectedText, setSelectedText] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [showForm, setShowForm] = useState(false);

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
      setSelectedText("");
      setCommentDraft("");
      setShowForm(false);
    },
  });

  function handleMouseUp() {
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length > 0) {
      setSelectedText(sel);
      setShowForm(true);
    }
  }

  function deleteAnnotation(annId: string) {
    annotationsApi.delete(projectId, annId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["annotations", itemKey] });
    });
  }

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
          <blockquote
            style={{
              margin: "0 0 0.25rem",
              fontStyle: "italic",
              color: "#555",
              fontSize: "0.8rem",
            }}
          >
            "{a.selected_text}"
          </blockquote>
          <span>{a.comment}</span>
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

      {showForm && (
        <div
          style={{
            background: "#f8f9fa",
            border: "1px solid #dadce0",
            borderRadius: "0.375rem",
            padding: "0.75rem",
            marginTop: "0.25rem",
          }}
        >
          <div
            style={{
              fontStyle: "italic",
              fontSize: "0.8rem",
              color: "#555",
              marginBottom: "0.4rem",
            }}
          >
            "{selectedText}"
          </div>
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
            placeholder="Your comment…"
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
            <button
              className="btn-primary"
              onClick={() => createMutation.mutate()}
              disabled={!commentDraft.trim() || createMutation.isPending}
              style={{ fontSize: "0.82rem" }}
            >
              Save
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setShowForm(false);
                setSelectedText("");
              }}
              style={{ fontSize: "0.82rem" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!showForm && (
        <div
          style={{
            fontSize: "0.75rem",
            color: "#bbb",
            marginTop: "0.2rem",
            userSelect: "none",
          }}
          onMouseUp={handleMouseUp}
        >
          Select text above to annotate
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaperCard
// ---------------------------------------------------------------------------

function PaperCard({
  item,
  projectId,
  showAnnotations,
}: {
  item: ScreeningNextItem;
  projectId: string;
  showAnnotations?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid #dadce0",
        borderRadius: "0.5rem",
        padding: "1.25rem",
        marginBottom: "1rem",
        background: "#fff",
      }}
    >
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem", lineHeight: 1.4 }}>
        {item.title ?? <em style={{ color: "#888" }}>No title</em>}
      </h3>
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
          fontSize: "0.85rem",
          color: "#5f6368",
        }}
      >
        {item.year && <span>{item.year}</span>}
        {item.authors && item.authors.length > 0 && (
          <span>
            {item.authors.slice(0, 3).join(", ")}
            {item.authors.length > 3 ? " et al." : ""}
          </span>
        )}
        {item.doi && (
          <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{item.doi}</span>
        )}
      </div>
      {(item.source_names ?? []).length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
          }}
        >
          {(item.source_names ?? []).map((s) => (
            <span
              key={s}
              style={{
                background: "#e8f0fe",
                color: "#1a73e8",
                borderRadius: "1rem",
                padding: "0.1rem 0.55rem",
                fontSize: "0.78rem",
                fontWeight: 500,
              }}
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {item.abstract && (
        <p
          style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.6, color: "#3c4043" }}
          onMouseUp={() => {/* text selection handled by AnnotationsPanel below */}}
        >
          {item.abstract}
        </p>
      )}
      {showAnnotations && <AnnotationsPanel projectId={projectId} item={item} />}
    </div>
  );
}

// Exclude dropdown (shared by ScreeningPanel and MixedPanel)
function ExcludeButton({
  onExclude,
  disabled,
}: {
  onExclude: (reason_code: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn-secondary"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        style={{ color: "#c5221f", borderColor: "#c5221f" }}
      >
        Exclude ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "#fff",
            border: "1px solid #dadce0",
            borderRadius: "0.375rem",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            zIndex: 100,
            minWidth: 200,
          }}
        >
          {EXCLUDE_REASONS.map((r) => (
            <button
              key={r.code}
              onClick={() => {
                setOpen(false);
                onExclude(r.code);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "0.55rem 1rem",
                background: "none",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontSize: "0.88rem",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "#f8f9fa";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "none";
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sequential Screen / Fulltext / Browse panel
// ---------------------------------------------------------------------------

function ScreeningPanel({
  projectId,
  bucket,
  source,
  strategy,
}: {
  projectId: string;
  bucket: string;
  source: string;
  strategy: string;
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Map bucket → mode for the API
  const bucketToMode: Record<string, string> = {
    ta_unscreened: "screen",
    ta_included: "screen",
    ft_pending: "fulltext",
    ft_included: "fulltext",
    extract_pending: "extract",
    extract_done: "extract",
  };
  const mode = bucketToMode[bucket] ?? "screen";

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await screeningApi.nextItem(projectId, {
        source_id: source,
        mode,
        strategy,
        bucket,
      });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
      }
    } catch (err: unknown) {
      const msg =
        (err as any)?.response?.data?.error?.message ??
        "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source, mode, strategy, bucket]);

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

  const decideMutation = useMutation({
    mutationFn: (body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      strategy?: string;
    }) => screeningApi.submitDecision(projectId, body),
    onSuccess: () => fetchNext(),
  });

  const bucketLabel = BUCKET_LABELS[bucket] ?? bucket;

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError)
    return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done)
    return <DoneCard bucketLabel={bucketLabel} projectId={projectId} />;

  const stage =
    bucket === "ta_unscreened" || bucket === "ta_included" ? "TA" : "FT";

  function decide(decision: "include" | "exclude", reason_code?: string) {
    decideMutation.mutate({
      record_id: item!.record_id ?? null,
      cluster_id: item!.cluster_id ?? null,
      stage: stage as "TA" | "FT",
      decision,
      reason_code,
      strategy,
    });
  }

  // Browse buckets show existing decisions but no action buttons
  const isBrowse = ["ta_included", "ft_included", "extract_done"].includes(bucket);

  return (
    <div>
      <ProgressBar remaining={item.remaining} />
      <PaperCard item={item} projectId={projectId} showAnnotations />
      {!isBrowse && (
        <>
          {decideMutation.isError && (
            <p style={{ color: "#c5221f", fontSize: "0.85rem" }}>
              Failed to submit decision. Try again.
            </p>
          )}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
              flexWrap: "wrap",
              position: "relative",
            }}
          >
            <button
              className="btn-primary"
              onClick={() => decide("include")}
              disabled={decideMutation.isPending}
              style={{ background: "#188038", border: "none" }}
            >
              Include
            </button>
            <ExcludeButton
              onExclude={(code) => decide("exclude", code)}
              disabled={decideMutation.isPending}
            />
            <button
              className="btn-secondary"
              onClick={fetchNext}
              disabled={decideMutation.isPending || loading}
              title="Skip — come back to this paper later"
            >
              Skip
            </button>
          </div>
        </>
      )}
      {isBrowse && (
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "0.5rem" }}>
          {item.ta_decision && (
            <span style={{ fontSize: "0.82rem", color: "#5f6368" }}>
              TA: <strong>{item.ta_decision}</strong>
            </span>
          )}
          {item.ft_decision && (
            <span style={{ fontSize: "0.82rem", color: "#5f6368" }}>
              FT: <strong>{item.ft_decision}</strong>
            </span>
          )}
          <button
            className="btn-secondary"
            onClick={fetchNext}
            disabled={loading}
            style={{ marginLeft: "auto" }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared ExtractionForm component
// ---------------------------------------------------------------------------

const EMPTY_EXTRACTION: ExtractionJson = {
  levels: [],
  dimensions: [],
  snippets: [],
  free_note: "",
  framework_updated: true,
  framework_update_note: "",
};

interface ExtractionFormProps {
  projectId: string;
  form: ExtractionJson;
  setForm: React.Dispatch<React.SetStateAction<ExtractionJson>>;
  levels: string[];
  onSave: () => void;
  onSkip: () => void;
  isPending: boolean;
  isError: boolean;
  toggleChip: (field: "levels" | "dimensions", value: string) => void;
}

function ExtractionForm({
  projectId,
  form,
  setForm,
  levels,
  onSave,
  onSkip,
  isPending,
  isError,
  toggleChip,
}: ExtractionFormProps) {
  const queryClient = useQueryClient();
  const addLevelRef = useRef<HTMLInputElement>(null);

  function updateSnippet(idx: number, key: keyof Snippet, value: string) {
    setForm((f) => {
      const snippets = f.snippets.map((s, i) => (i === idx ? { ...s, [key]: value } : s));
      return { ...f, snippets };
    });
  }

  function addSnippet() {
    setForm((f) => ({
      ...f,
      snippets: [...f.snippets, { snippet: "", note: "", tag: "" }],
    }));
  }

  function removeSnippet(idx: number) {
    setForm((f) => ({ ...f, snippets: f.snippets.filter((_, i) => i !== idx) }));
  }

  function addCustomLevel(newLevel: string) {
    setForm((f) => ({ ...f, levels: [...f.levels, newLevel] }));
    projectsApi
      .updateCriteria(projectId, { inclusion: [], exclusion: [], levels: [...levels, newLevel] })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      });
  }

  return (
    <div>
      {/* Levels */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Levels of analysis
        </div>
        <div
          style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}
        >
          {levels.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => toggleChip("levels", lv)}
              style={{
                padding: "0.25rem 0.7rem",
                borderRadius: "1rem",
                border: `2px solid ${form.levels.includes(lv) ? "#1a73e8" : "#dadce0"}`,
                background: form.levels.includes(lv) ? "#e8f0fe" : "#f8f9fa",
                color: form.levels.includes(lv) ? "#1a73e8" : "#5f6368",
                fontWeight: form.levels.includes(lv) ? 600 : 400,
                fontSize: "0.82rem",
                cursor: "pointer",
              }}
            >
              {lv}
            </button>
          ))}
          <input
            ref={addLevelRef}
            type="text"
            placeholder="+ level…"
            style={{
              fontSize: "0.8rem",
              border: "1px dashed #aaa",
              borderRadius: "1rem",
              padding: "0.2rem 0.6rem",
              background: "none",
              outline: "none",
              width: 80,
              color: "#555",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = e.currentTarget.value.trim();
                if (val) {
                  addCustomLevel(val);
                  e.currentTarget.value = "";
                }
              }
            }}
          />
        </div>
      </div>

      {/* Dimensions */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Dimensions
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {DIMENSIONS.map((dim) => (
            <button
              key={dim}
              type="button"
              onClick={() => toggleChip("dimensions", dim)}
              style={{
                padding: "0.25rem 0.7rem",
                borderRadius: "1rem",
                border: `2px solid ${form.dimensions.includes(dim) ? "#8f3f97" : "#dadce0"}`,
                background: form.dimensions.includes(dim) ? "#f3e5f5" : "#f8f9fa",
                color: form.dimensions.includes(dim) ? "#8f3f97" : "#5f6368",
                fontWeight: form.dimensions.includes(dim) ? 600 : 400,
                fontSize: "0.82rem",
                cursor: "pointer",
              }}
            >
              {dim}
            </button>
          ))}
        </div>
      </div>

      {/* Snippets */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Evidence snippets
        </div>
        {form.snippets.map((snip, idx) => (
          <div
            key={idx}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 0.7fr auto",
              gap: "0.35rem",
              marginBottom: "0.3rem",
              alignItems: "center",
            }}
          >
            <input
              type="text"
              placeholder="Snippet…"
              value={snip.snippet}
              onChange={(e) => updateSnippet(idx, "snippet", e.target.value)}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Note…"
              value={snip.note}
              onChange={(e) => updateSnippet(idx, "note", e.target.value)}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Tag…"
              value={snip.tag ?? ""}
              onChange={(e) => updateSnippet(idx, "tag", e.target.value)}
              style={inputStyle}
            />
            <button
              onClick={() => removeSnippet(idx)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#c00",
                fontSize: "1rem",
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={addSnippet}
          style={{
            fontSize: "0.8rem",
            padding: "0.25rem 0.6rem",
            border: "1px dashed #aaa",
            background: "none",
            cursor: "pointer",
            borderRadius: 4,
            color: "#555",
          }}
        >
          + Add snippet
        </button>
      </div>

      {/* Free note */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Free note
        </div>
        <textarea
          value={form.free_note}
          onChange={(e) => setForm((f) => ({ ...f, free_note: e.target.value }))}
          rows={3}
          placeholder="General notes about this paper…"
          style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit" }}
        />
      </div>

      {/* Framework updated */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Did this paper update the conceptual framework?
        </div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          {[true, false].map((val) => (
            <label
              key={String(val)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                cursor: "pointer",
                fontSize: "0.88rem",
              }}
            >
              <input
                type="radio"
                name="framework_updated"
                checked={form.framework_updated === val}
                onChange={() =>
                  setForm((f) => ({
                    ...f,
                    framework_updated: val,
                    framework_update_note: val ? "" : f.framework_update_note,
                  }))
                }
              />
              {val ? "Yes — added new concepts" : "No — nothing new"}
            </label>
          ))}
        </div>
        {!form.framework_updated && (
          <input
            type="text"
            placeholder="Why no new concepts?"
            value={form.framework_update_note}
            onChange={(e) =>
              setForm((f) => ({ ...f, framework_update_note: e.target.value }))
            }
            style={{ ...inputStyle, marginTop: "0.5rem", width: "100%" }}
          />
        )}
      </div>

      {isError && (
        <p style={{ color: "#c5221f", marginBottom: "0.5rem" }}>
          Failed to save extraction. Try again.
        </p>
      )}

      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button className="btn-primary" onClick={onSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          className="btn-secondary"
          onClick={onSkip}
          disabled={isPending}
          title="Skip — come back later"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mixed mode panel (TA + FT + optional Extraction in one step)
// ---------------------------------------------------------------------------

function MixedPanel({
  projectId,
  source,
  autoAdvanceFT,
  autoAdvanceExtract,
  levels,
}: {
  projectId: string;
  source: string;
  autoAdvanceFT: boolean;
  autoAdvanceExtract: boolean;
  levels: string[];
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [taSubmitted, setTaSubmitted] = useState(false);
  const [phase, setPhase] = useState<"ta" | "ft" | "extraction">("ta");
  const [form, setForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setTaSubmitted(false);
    setPhase("ta");
    setForm(EMPTY_EXTRACTION);
    try {
      const res = await screeningApi.nextItem(projectId, {
        source_id: source,
        mode: "mixed",
        strategy: "mixed",
      });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
        // Restore phase from existing decisions
        const d = res.data;
        if (d.ft_decision) {
          setPhase("extraction");
        } else if (d.ta_decision === "include") {
          setPhase("ft");
          setTaSubmitted(true);
        }
      }
    } catch (err: unknown) {
      const msg =
        (err as any)?.response?.data?.error?.message ??
        "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source]);

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

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
    mutationFn: (payload: {
      record_id?: string | null;
      cluster_id?: string | null;
      extracted_json: ExtractionJson;
    }) => screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => fetchNext(),
  });

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError)
    return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done)
    return <DoneCard bucketLabel="Mixed Screening" projectId={projectId} />;

  const showFT =
    phase === "ft" || phase === "extraction" || taSubmitted || item.ta_decision === "include";

  async function handleTAInclude() {
    try {
      await screeningApi.submitDecision(projectId, {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "TA",
        decision: "include",
        strategy: "mixed",
      });
      setTaSubmitted(true);
      if (autoAdvanceFT) setPhase("ft");
    } catch { /* shown via mutation error */ }
  }

  function handleTAExclude(reason_code: string) {
    decideMutation.mutate(
      {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "TA",
        decision: "exclude",
        reason_code,
        strategy: "mixed",
      },
      { onSuccess: () => fetchNext() }
    );
  }

  function handleFT(decision: "include" | "exclude", reason_code?: string) {
    decideMutation.mutate(
      {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "FT",
        decision,
        reason_code,
        strategy: "mixed",
      },
      {
        onSuccess: () => {
          if (decision === "include" && autoAdvanceExtract) {
            setPhase("extraction");
          } else {
            fetchNext();
          }
        },
      }
    );
  }

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => {
      const arr = f[field];
      return {
        ...f,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      };
    });
  }

  return (
    <div>
      <ProgressBar remaining={item.remaining} />
      <PaperCard item={item} projectId={projectId} showAnnotations />
      {decideMutation.isError && (
        <p style={{ color: "#c5221f", fontSize: "0.85rem" }}>
          Failed to submit decision. Try again.
        </p>
      )}

      {/* TA section */}
      {!showFT && (
        <div>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "#5f6368",
              marginBottom: "0.4rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Title / Abstract
          </div>
          <div
            style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <button
              className="btn-primary"
              onClick={handleTAInclude}
              disabled={decideMutation.isPending}
              style={{ background: "#188038", border: "none" }}
            >
              Include → continue to full-text
            </button>
            <ExcludeButton
              onExclude={handleTAExclude}
              disabled={decideMutation.isPending}
            />
            <button
              className="btn-secondary"
              onClick={fetchNext}
              disabled={decideMutation.isPending || loading}
              title="Skip — come back later"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* FT section */}
      {showFT && phase !== "extraction" && (
        <div>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "#1a73e8",
              marginBottom: "0.4rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Full-text Review
          </div>
          <div
            style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <button
              className="btn-primary"
              onClick={() => handleFT("include")}
              disabled={decideMutation.isPending}
              style={{ background: "#1a73e8", border: "none" }}
            >
              FT Include{autoAdvanceExtract ? " → Extract" : ""}
            </button>
            <ExcludeButton
              onExclude={(code) => handleFT("exclude", code)}
              disabled={decideMutation.isPending}
            />
            <button
              className="btn-secondary"
              onClick={fetchNext}
              disabled={decideMutation.isPending || loading}
              title="Skip FT — come back later"
            >
              Skip FT
            </button>
          </div>
        </div>
      )}

      {/* Inline extraction phase */}
      {phase === "extraction" && (
        <div style={{ marginTop: "0.5rem" }}>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              color: "#8f3f97",
              marginBottom: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Extract Data
          </div>
          <ExtractionForm
            projectId={projectId}
            form={form}
            setForm={setForm}
            levels={levels}
            onSave={() =>
              saveMutation.mutate({
                record_id: item!.record_id ?? null,
                cluster_id: item!.cluster_id ?? null,
                extracted_json: form,
              })
            }
            onSkip={fetchNext}
            isPending={saveMutation.isPending}
            isError={saveMutation.isError}
            toggleChip={toggleChip}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extract workspace
// ---------------------------------------------------------------------------

function ExtractionPanel({
  projectId,
  source,
  strategy,
  levels,
}: {
  projectId: string;
  source: string;
  strategy: string;
  levels: string[];
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ExtractionJson>(EMPTY_EXTRACTION);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await screeningApi.nextItem(projectId, {
        source_id: source,
        mode: "extract",
        strategy,
        bucket: "extract_pending",
      });
      if ((res.data as any).error) {
        setFetchError((res.data as any).error.message ?? "Server error — please retry.");
      } else {
        setItem(res.data);
        setForm(EMPTY_EXTRACTION);
      }
    } catch (err: unknown) {
      const msg =
        (err as any)?.response?.data?.error?.message ??
        "Check your connection and try again.";
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, source, strategy]);

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

  const saveMutation = useMutation({
    mutationFn: (payload: {
      record_id?: string | null;
      cluster_id?: string | null;
      extracted_json: ExtractionJson;
    }) => screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => fetchNext(),
  });

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError)
    return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done)
    return <DoneCard bucketLabel="Extract Data" projectId={projectId} />;

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => {
      const arr = f[field];
      return {
        ...f,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      };
    });
  }

  return (
    <div>
      <ProgressBar remaining={item.remaining} />

      {/* Compact paper header */}
      <div
        style={{
          border: "1px solid #dadce0",
          borderRadius: "0.5rem",
          padding: "0.85rem 1.1rem",
          marginBottom: "1rem",
          background: "#fff",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
          {item.title ?? <em style={{ color: "#888" }}>No title</em>}
        </div>
        <div
          style={{
            fontSize: "0.82rem",
            color: "#5f6368",
            display: "flex",
            gap: "0.6rem",
            flexWrap: "wrap",
          }}
        >
          {item.year && <span>{item.year}</span>}
          {(item.source_names ?? []).map((s) => (
            <span
              key={s}
              style={{
                background: "#e8f0fe",
                color: "#1a73e8",
                borderRadius: "1rem",
                padding: "0 0.45rem",
                fontSize: "0.75rem",
              }}
            >
              {s}
            </span>
          ))}
        </div>
        <AnnotationsPanel projectId={projectId} item={item} />
      </div>

      <ExtractionForm
        projectId={projectId}
        form={form}
        setForm={setForm}
        levels={levels}
        onSave={() =>
          saveMutation.mutate({
            record_id: item!.record_id ?? null,
            cluster_id: item!.cluster_id ?? null,
            extracted_json: form,
          })
        }
        onSkip={fetchNext}
        isPending={saveMutation.isPending}
        isError={saveMutation.isError}
        toggleChip={toggleChip}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ScreeningWorkspace() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [criteriaOpen, setCriteriaOpen] = useState(false);

  const bucket = searchParams.get("bucket") ?? "ta_unscreened";
  const legacyMode = searchParams.get("mode"); // backward compat
  const source = searchParams.get("source") ?? "all";
  const strategy = (searchParams.get("strategy") ?? "sequential") as "sequential" | "mixed";

  // Auto-advance toggles (localStorage-persisted, mixed mode only)
  const [autoAdvanceFT, setAutoAdvanceFT] = useLocalStorage("autoAdvanceFT", true);
  const [autoAdvanceExtract, setAutoAdvanceExtract] = useLocalStorage("autoAdvanceExtract", true);

  const { data: projectData } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const criteria = projectData?.criteria ?? { inclusion: [], exclusion: [] };
  const hasCriteria = criteria.inclusion.length > 0 || criteria.exclusion.length > 0;

  // Project-level custom levels (fallback to defaults)
  const projectLevels =
    (projectData?.criteria?.levels ?? []).length > 0
      ? (projectData!.criteria!.levels as string[])
      : DEFAULT_LEVELS;

  if (!projectId) return null;

  const bucketLabel =
    strategy === "mixed" ? "Mixed Screening" : BUCKET_LABELS[bucket] ?? bucket;
  const sourceName = source === "all" ? "All databases" : source;

  const showExtractPanel =
    strategy === "sequential" &&
    (bucket === "extract_pending" || bucket === "extract_done" || legacyMode === "extract");
  const showMixed = strategy === "mixed";

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          ← Project
        </Link>
        <span style={{ color: "#5f6368", fontSize: "0.85rem", marginLeft: "1rem" }}>
          {bucketLabel} · {sourceName}
        </span>

        {/* Auto-advance toggles (mixed mode only) */}
        {showMixed && (
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              marginLeft: "auto",
              alignItems: "center",
            }}
          >
            <label
              style={{
                fontSize: "0.8rem",
                color: "#5f6368",
                display: "flex",
                alignItems: "center",
                gap: "0.25rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={autoAdvanceFT}
                onChange={(e) => setAutoAdvanceFT(e.target.checked)}
              />
              Auto FT
            </label>
            <label
              style={{
                fontSize: "0.8rem",
                color: "#5f6368",
                display: "flex",
                alignItems: "center",
                gap: "0.25rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={autoAdvanceExtract}
                onChange={(e) => setAutoAdvanceExtract(e.target.checked)}
              />
              Auto Extract
            </label>
          </div>
        )}
      </header>

      <main style={{ maxWidth: 680, margin: "0 auto" }}>
        {/* Criteria reference panel */}
        {hasCriteria && (
          <div
            style={{
              marginBottom: "1rem",
              border: "1px solid #dadce0",
              borderRadius: "0.5rem",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => setCriteriaOpen((v) => !v)}
              style={{
                width: "100%",
                background: "#f8f9fa",
                border: "none",
                borderBottom: criteriaOpen ? "1px solid #dadce0" : "none",
                padding: "0.6rem 1rem",
                textAlign: "left",
                cursor: "pointer",
                fontSize: "0.85rem",
                color: "#5f6368",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 500 }}>Criteria reference</span>
              <span>{criteriaOpen ? "▲" : "▼"}</span>
            </button>
            {criteriaOpen && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                  padding: "0.9rem 1rem",
                  background: "#fff",
                }}
              >
                <div>
                  <div
                    style={{
                      color: "#188038",
                      fontWeight: 600,
                      marginBottom: "0.4rem",
                      fontSize: "0.82rem",
                    }}
                  >
                    ✓ Include if
                  </div>
                  {criteria.inclusion.map((c) => (
                    <div
                      key={c.id}
                      style={{ fontSize: "0.82rem", marginBottom: "0.25rem", color: "#3c4043" }}
                    >
                      • {c.text}
                    </div>
                  ))}
                  {criteria.inclusion.length === 0 && (
                    <em style={{ fontSize: "0.78rem", color: "#888" }}>None defined</em>
                  )}
                </div>
                <div>
                  <div
                    style={{
                      color: "#c5221f",
                      fontWeight: 600,
                      marginBottom: "0.4rem",
                      fontSize: "0.82rem",
                    }}
                  >
                    ✕ Exclude if
                  </div>
                  {criteria.exclusion.map((c) => (
                    <div
                      key={c.id}
                      style={{ fontSize: "0.82rem", marginBottom: "0.25rem", color: "#3c4043" }}
                    >
                      • {c.text}
                    </div>
                  ))}
                  {criteria.exclusion.length === 0 && (
                    <em style={{ fontSize: "0.78rem", color: "#888" }}>None defined</em>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {showMixed ? (
          <MixedPanel
            projectId={projectId}
            source={source}
            autoAdvanceFT={autoAdvanceFT}
            autoAdvanceExtract={autoAdvanceExtract}
            levels={projectLevels}
          />
        ) : showExtractPanel ? (
          <ExtractionPanel
            projectId={projectId}
            source={source}
            strategy={strategy}
            levels={projectLevels}
          />
        ) : (
          <ScreeningPanel
            projectId={projectId}
            bucket={bucket}
            source={source}
            strategy={strategy}
          />
        )}
      </main>
    </div>
  );
}
