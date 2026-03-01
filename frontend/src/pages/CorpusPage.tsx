import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { corporaApi, sourcesApi, type Corpus } from "../api/client";

export default function CorpusPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
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

  const createMutation = useMutation({
    mutationFn: async () => {
      const c = await corporaApi
        .create(projectId!, {
          name,
          description: description || undefined,
          source_ids: selectedSources,
          saturation_threshold: threshold,
        })
        .then((r) => r.data);
      // auto-generate queue
      await corporaApi.generateQueue(projectId!, c.id);
      return c;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["corpora", projectId] });
      setShowForm(false);
      setName("");
      setDescription("");
      setSelectedSources([]);
      setThreshold(10);
      setError(null);
    },
    onError: (e: any) => {
      setError(e?.response?.data?.detail ?? "Failed to create corpus");
    },
  });

  const toggleSource = (sid: string) => {
    setSelectedSources((prev) =>
      prev.includes(sid) ? prev.filter((s) => s !== sid) : [...prev, sid]
    );
  };

  const canCreate = name.trim().length > 0;

  return (
    <div style={{ maxWidth: 860, margin: "2rem auto", padding: "0 1rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <Link to={`/projects/${projectId}`} style={{ color: "#1a73e8" }}>
          ← Project
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Corpora</h1>
        <button
          onClick={() => setShowForm((f) => !f)}
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
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Full dataset"
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>Sources in scope</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.25rem" }}>
              {sources.map((src) => {
                const selected = selectedSources.includes(src.id);
                return (
                  <button
                    key={src.id}
                    onClick={() => toggleSource(src.id)}
                    style={{
                      padding: "0.3rem 0.75rem",
                      border: selected ? "2px solid #1a73e8" : "1px solid #ccc",
                      borderRadius: 20,
                      background: selected ? "#e8f0fe" : "#fff",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                      color: selected ? "#1a73e8" : "#333",
                      fontWeight: selected ? 600 : 400,
                    }}
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
            {createMutation.isPending ? "Creating…" : "Create & Generate Queue"}
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
          {corpora.map((c) => (
            <CorpusCard key={c.id} corpus={c} projectId={projectId!} />
          ))}
        </div>
      )}
    </div>
  );
}

function CorpusCard({ corpus, projectId }: { corpus: Corpus; projectId: string }) {
  const satPct =
    corpus.saturation_threshold > 0
      ? Math.min(
          100,
          Math.round(
            (corpus.consecutive_no_novelty / corpus.saturation_threshold) * 100
          )
        )
      : 0;

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: "1.05rem" }}>{corpus.name}</span>
          {corpus.description && (
            <span style={{ marginLeft: "0.75rem", color: "#555", fontSize: "0.875rem" }}>
              {corpus.description}
            </span>
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
          }}
        >
          Screen →
        </Link>
      </div>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.875rem", color: "#555" }}>
        <span>Queue: <strong>{corpus.queue_size}</strong></span>
        <span>Extracted: <strong>{corpus.total_extracted}</strong></span>
        {corpus.stopped_at ? (
          <span style={{ color: "#2e7d32", fontWeight: 600 }}>Saturated</span>
        ) : (
          <span>
            Non-novel streak: <strong>{corpus.consecutive_no_novelty}</strong> / {corpus.saturation_threshold}
          </span>
        )}
      </div>

      {/* Saturation progress bar */}
      <div style={{ height: 6, background: "#e0e0e0", borderRadius: 3, overflow: "hidden", maxWidth: 320 }}>
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
