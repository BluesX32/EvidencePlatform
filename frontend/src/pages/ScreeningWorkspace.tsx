import React, { useState, useEffect, useCallback } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { screeningApi } from "../api/client";
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

const LEVELS = [
  "gene", "molecular", "cellular", "tissue/organ",
  "patient/clinical", "population", "societal",
];

const DIMENSIONS = ["objective", "subjective", "societal"];

const inputStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.85rem",
  width: "100%",
  boxSizing: "border-box",
};

// ---------------------------------------------------------------------------
// Shared helper components
// ---------------------------------------------------------------------------

function ProgressBar({ remaining }: { remaining: number | undefined }) {
  if (remaining === undefined) return null;
  return (
    <div style={{ fontSize: "0.85rem", color: "#5f6368", marginBottom: "0.5rem" }}>
      {remaining} remaining
    </div>
  );
}

function DoneCard({ mode, projectId }: { mode: string; projectId: string }) {
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
        No more items for this{" "}
        {mode === "screen"
          ? "screening"
          : mode === "fulltext"
          ? "full-text review"
          : mode === "mixed"
          ? "mixed screening"
          : "extraction"}{" "}
        session.
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

function PaperCard({ item }: { item: ScreeningNextItem }) {
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
          <a
            href={`https://doi.org/${item.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#1a73e8", textDecoration: "none" }}
          >
            DOI
          </a>
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
        <p style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.6, color: "#3c4043" }}>
          {item.abstract}
        </p>
      )}
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
              onClick={() => { setOpen(false); onExclude(r.code); }}
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
// Sequential Screen / Fulltext panel
// ---------------------------------------------------------------------------

function ScreeningPanel({
  projectId,
  mode,
  source,
  strategy,
}: {
  projectId: string;
  mode: string;
  source: string;
  strategy: string;
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await screeningApi.nextItem(projectId, { source_id: source, mode, strategy });
      setItem(res.data);
    } catch {
      setFetchError("Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [projectId, source, mode, strategy]);

  useEffect(() => { fetchNext(); }, [fetchNext]);

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

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError) return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done) return <DoneCard mode={mode} projectId={projectId} />;

  const stage = mode === "screen" ? "TA" : "FT";

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

  return (
    <div>
      <ProgressBar remaining={item.remaining} />
      <PaperCard item={item} />
      {decideMutation.isError && (
        <p style={{ color: "#c5221f", fontSize: "0.85rem" }}>Failed to submit decision. Try again.</p>
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
        <ExcludeButton onExclude={(code) => decide("exclude", code)} disabled={decideMutation.isPending} />
        <button
          className="btn-secondary"
          onClick={fetchNext}
          disabled={decideMutation.isPending || loading}
          title="Skip — come back to this paper later"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mixed mode panel (TA + FT in one step)
// ---------------------------------------------------------------------------

function MixedPanel({
  projectId,
  source,
}: {
  projectId: string;
  source: string;
}) {
  const [item, setItem] = useState<ScreeningNextItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // taSubmitted tracks whether TA was just submitted in this render (before next fetch)
  const [taSubmitted, setTaSubmitted] = useState(false);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setTaSubmitted(false);
    try {
      const res = await screeningApi.nextItem(projectId, {
        source_id: source,
        mode: "mixed",
        strategy: "mixed",
      });
      setItem(res.data);
    } catch {
      setFetchError("Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [projectId, source]);

  useEffect(() => { fetchNext(); }, [fetchNext]);

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

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError) return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done) return <DoneCard mode="mixed" projectId={projectId} />;

  // Show FT controls if TA was just submitted OR if backend reports ta_decision=include
  const showFT = taSubmitted || item.ta_decision === "include";

  async function handleTAInclude() {
    try {
      await screeningApi.submitDecision(projectId, {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "TA",
        decision: "include",
        strategy: "mixed",
      });
      setTaSubmitted(true); // reveal FT controls, stay on same item
    } catch {
      // will show via mutation error below
    }
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
    // strategy=mixed: backend auto-creates TA=include if absent
    decideMutation.mutate(
      {
        record_id: item!.record_id ?? null,
        cluster_id: item!.cluster_id ?? null,
        stage: "FT",
        decision,
        reason_code,
        strategy: "mixed",
      },
      { onSuccess: () => fetchNext() }
    );
  }

  return (
    <div>
      <ProgressBar remaining={item.remaining} />
      <PaperCard item={item} />
      {decideMutation.isError && (
        <p style={{ color: "#c5221f", fontSize: "0.85rem" }}>
          Failed to submit decision. Try again.
        </p>
      )}

      {/* TA section — hidden once FT controls appear */}
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
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
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

      {/* FT section — revealed after TA include */}
      {showFT && (
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
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn-primary"
              onClick={() => handleFT("include")}
              disabled={decideMutation.isPending}
              style={{ background: "#1a73e8", border: "none" }}
            >
              FT Include
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extract workspace
// ---------------------------------------------------------------------------

const EMPTY_EXTRACTION: ExtractionJson = {
  levels: [],
  dimensions: [],
  snippets: [],
  free_note: "",
  framework_updated: true,
  framework_update_note: "",
};

function ExtractionPanel({
  projectId,
  source,
  strategy,
}: {
  projectId: string;
  source: string;
  strategy: string;
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
      });
      setItem(res.data);
      setForm(EMPTY_EXTRACTION);
    } catch {
      setFetchError("Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [projectId, source, strategy]);

  useEffect(() => { fetchNext(); }, [fetchNext]);

  const saveMutation = useMutation({
    mutationFn: (payload: {
      record_id?: string | null;
      cluster_id?: string | null;
      extracted_json: ExtractionJson;
    }) => screeningApi.submitExtraction(projectId, payload),
    onSuccess: () => fetchNext(),
  });

  if (loading) return <p style={{ color: "#888" }}>Loading…</p>;
  if (fetchError) return <ErrorCard message={fetchError} onRetry={fetchNext} projectId={projectId} />;
  if (!item || item.done) return <DoneCard mode="extract" projectId={projectId} />;

  function toggleChip(field: "levels" | "dimensions", value: string) {
    setForm((f) => {
      const arr = f[field];
      return {
        ...f,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      };
    });
  }

  function updateSnippet(idx: number, key: keyof Snippet, value: string) {
    setForm((f) => {
      const snippets = f.snippets.map((s, i) => (i === idx ? { ...s, [key]: value } : s));
      return { ...f, snippets };
    });
  }

  function addSnippet() {
    setForm((f) => ({ ...f, snippets: [...f.snippets, { snippet: "", note: "", tag: "" }] }));
  }

  function removeSnippet(idx: number) {
    setForm((f) => ({ ...f, snippets: f.snippets.filter((_, i) => i !== idx) }));
  }

  return (
    <div>
      <ProgressBar remaining={item.remaining} />

      {/* Compact paper card */}
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
      </div>

      {/* Levels */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          Levels of analysis
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {LEVELS.map((lv) => (
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

      {saveMutation.isError && (
        <p style={{ color: "#c5221f", marginBottom: "0.5rem" }}>
          Failed to save extraction. Try again.
        </p>
      )}

      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button
          className="btn-primary"
          onClick={() =>
            saveMutation.mutate({
              record_id: item.record_id ?? null,
              cluster_id: item.cluster_id ?? null,
              extracted_json: form,
            })
          }
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
        <button
          className="btn-secondary"
          onClick={fetchNext}
          disabled={saveMutation.isPending || loading}
          title="Skip — come back later"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ScreeningWorkspace() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  const mode = searchParams.get("mode") ?? "screen";
  const source = searchParams.get("source") ?? "all";
  const strategy = (searchParams.get("strategy") ?? "sequential") as "sequential" | "mixed";

  if (!projectId) return null;

  const modeLabel =
    strategy === "mixed"
      ? "Mixed Screening"
      : mode === "screen"
      ? "Screen (Title/Abstract)"
      : mode === "fulltext"
      ? "Full-text Review"
      : "Extract Data";

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          ← Project
        </Link>
        <span style={{ color: "#5f6368", fontSize: "0.9rem", marginLeft: "1rem" }}>
          {modeLabel}
        </span>
      </header>
      <main style={{ maxWidth: 680, margin: "0 auto" }}>
        {strategy === "mixed" ? (
          <MixedPanel projectId={projectId} source={source} />
        ) : mode === "extract" ? (
          <ExtractionPanel projectId={projectId} source={source} strategy={strategy} />
        ) : (
          <ScreeningPanel
            projectId={projectId}
            mode={mode}
            source={source}
            strategy={strategy}
          />
        )}
      </main>
    </div>
  );
}
