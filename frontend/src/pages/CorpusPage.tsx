import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { corporaApi, sourcesApi, type Corpus, type Source } from "../api/client";

export default function CorpusPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  // Source selection: single (default) or multi (advanced)
  const [advancedMode, setAdvancedMode] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [multiSources, setMultiSources] = useState<string[]>([]);

  // Name: auto-derived from source, or manually typed
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [threshold, setThreshold] = useState(10);
  const [error, setError] = useState<string | null>(null);

  const { data: corpora = [], isLoading } = useQuery({
    queryKey: ["corpora", projectId],
    queryFn: () => corporaApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: sources = [] } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => sourcesApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  // Compute active source ids and auto-derived name
  const activeSourceIds = advancedMode
    ? multiSources
    : selectedSource
    ? [selectedSource]
    : [];

  const derivedName = advancedMode
    ? multiSources
        .map((sid) => sources.find((s: Source) => s.id === sid)?.name ?? sid)
        .join(" + ")
    : selectedSource
    ? sources.find((s: Source) => s.id === selectedSource)?.name ?? ""
    : "";

  const activeName = nameTouched ? name : derivedName;

  const createMutation = useMutation({
    mutationFn: async () => {
      const c = await corporaApi
        .create(projectId!, {
          name: activeName,
          source_ids: activeSourceIds,
          saturation_threshold: threshold,
        })
        .then((r) => r.data);
      await corporaApi.generateQueue(projectId!, c.id);
      return c;
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["corpora", projectId] });
      navigate(`/projects/${projectId}/corpora/${c.id}/screen`);
    },
    onError: (e: any) => {
      setError(e?.response?.data?.detail ?? "Failed to create corpus");
    },
  });

  const toggleMultiSource = (sid: string) =>
    setMultiSources((prev) =>
      prev.includes(sid) ? prev.filter((s) => s !== sid) : [...prev, sid]
    );

  const canCreate = activeName.trim().length > 0 && activeSourceIds.length > 0;

  const resetForm = () => {
    setShowForm(false);
    setAdvancedMode(false);
    setSelectedSource(null);
    setMultiSources([]);
    setName("");
    setNameTouched(false);
    setThreshold(10);
    setError(null);
  };

  return (
    <div style={{ maxWidth: 860, margin: "2rem auto", padding: "0 1rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <Link to={`/projects/${projectId}`} style={{ color: "#1a73e8" }}>
          ← Project
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Corpora</h1>
        <button
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
          style={{
            marginLeft: "auto",
            padding: "0.45rem 1rem",
            background: "#1a73e8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.9rem",
          }}
        >
          {showForm ? "Cancel" : "+ New Corpus"}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div
          style={{
            border: "1px solid #ccc",
            borderRadius: 8,
            padding: "1.25rem",
            marginBottom: "1.5rem",
            background: "#fafafa",
          }}
        >
          <h3 style={{ margin: "0 0 1rem" }}>Create Corpus</h3>
          {error && (
            <div style={{ color: "#c00", marginBottom: "0.75rem", fontSize: "0.9rem" }}>
              {error}
            </div>
          )}

          {/* Source selection */}
          <div style={{ marginBottom: "0.75rem" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.4rem",
              }}
            >
              <label style={labelStyle}>
                {advancedMode ? "Sources in scope" : "Database (source)"}
              </label>
              <button
                onClick={() => {
                  setAdvancedMode((m) => !m);
                  setSelectedSource(null);
                  setMultiSources([]);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#1a73e8",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  padding: 0,
                }}
              >
                {advancedMode ? "Simple (single source)" : "Advanced (multi-source)"}
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {sources.map((src: Source) => {
                const selected = advancedMode
                  ? multiSources.includes(src.id)
                  : selectedSource === src.id;
                return (
                  <button
                    key={src.id}
                    onClick={() =>
                      advancedMode
                        ? toggleMultiSource(src.id)
                        : setSelectedSource(selected ? null : src.id)
                    }
                    style={sourceChipStyle(selected)}
                  >
                    {src.name}
                  </button>
                );
              })}
              {sources.length === 0 && (
                <span style={{ color: "#888", fontSize: "0.85rem" }}>No sources found</span>
              )}
            </div>
          </div>

          {/* Name */}
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>
              Name *
              {!nameTouched && derivedName && (
                <span style={{ fontWeight: 400, color: "#888", marginLeft: "0.4rem" }}>
                  (auto)
                </span>
              )}
            </label>
            <input
              value={activeName}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="e.g. PubMed 2024"
              style={inputStyle}
            />
          </div>

          {/* Saturation threshold */}
          <div style={{ marginBottom: "1rem" }}>
            <label style={labelStyle}>Saturation threshold</label>
            <input
              type="number"
              value={threshold}
              min={1}
              max={100}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ ...inputStyle, width: 100 }}
            />
            <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "#555" }}>
              consecutive non-novel extractions before stopping
            </span>
          </div>

          <button
            disabled={!canCreate || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            style={{
              padding: "0.5rem 1.25rem",
              background: canCreate ? "#1a73e8" : "#aaa",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: canCreate ? "pointer" : "not-allowed",
              fontSize: "0.9rem",
            }}
          >
            {createMutation.isPending ? "Creating…" : "Create & Start Screening →"}
          </button>
        </div>
      )}

      {/* Corpus list */}
      {isLoading ? (
        <p style={{ color: "#888" }}>Loading…</p>
      ) : corpora.length === 0 ? (
        <p style={{ color: "#888" }}>No corpora yet. Create one to start screening.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {corpora.map((c: Corpus) => (
            <CorpusCard key={c.id} corpus={c} projectId={projectId!} sources={sources} />
          ))}
        </div>
      )}
    </div>
  );
}

function CorpusCard({
  corpus,
  projectId,
  sources,
}: {
  corpus: Corpus;
  projectId: string;
  sources: Source[];
}) {
  const satPct =
    corpus.saturation_threshold > 0
      ? Math.min(
          100,
          Math.round((corpus.consecutive_no_novelty / corpus.saturation_threshold) * 100)
        )
      : 0;

  const sourceNames = (corpus.source_ids ?? []).map(
    (sid) => sources.find((s: Source) => s.id === sid)?.name ?? sid
  );

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem 1.25rem",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: "1.05rem" }}>{corpus.name}</span>
          {sourceNames.length > 0 && (
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
              {sourceNames.map((n) => (
                <span
                  key={n}
                  style={{
                    background: "#e8f0fe",
                    color: "#1a73e8",
                    borderRadius: 12,
                    padding: "0.1rem 0.5rem",
                    fontSize: "0.78rem",
                  }}
                >
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
        <Link
          to={`/projects/${projectId}/corpora/${corpus.id}/screen`}
          style={{
            padding: "0.35rem 0.9rem",
            background: "#1a73e8",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.875rem",
            whiteSpace: "nowrap",
            marginLeft: "1rem",
          }}
        >
          Screen →
        </Link>
      </div>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.875rem", color: "#555" }}>
        <span>
          Queue: <strong>{corpus.queue_size}</strong>
        </span>
        <span>
          Extracted: <strong>{corpus.total_extracted}</strong>
        </span>
        {corpus.stopped_at ? (
          <span style={{ color: "#2e7d32", fontWeight: 600 }}>Saturated</span>
        ) : (
          <span>
            Non-novel streak: <strong>{corpus.consecutive_no_novelty}</strong> /{" "}
            {corpus.saturation_threshold}
          </span>
        )}
      </div>

      {/* Saturation progress bar */}
      <div
        style={{ height: 6, background: "#e0e0e0", borderRadius: 3, overflow: "hidden", maxWidth: 320 }}
      >
        <div
          style={{
            height: "100%",
            width: `${satPct}%`,
            background: corpus.stopped_at ? "#2e7d32" : "#1a73e8",
            borderRadius: 3,
            transition: "width 0.3s",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const sourceChipStyle = (selected: boolean): React.CSSProperties => ({
  padding: "0.3rem 0.75rem",
  border: selected ? "2px solid #1a73e8" : "1px solid #ccc",
  borderRadius: 20,
  background: selected ? "#e8f0fe" : "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
  color: selected ? "#1a73e8" : "#333",
  fontWeight: selected ? 600 : 400,
});

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 500,
  marginBottom: "0.25rem",
  fontSize: "0.875rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.6rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.9rem",
  boxSizing: "border-box",
};
