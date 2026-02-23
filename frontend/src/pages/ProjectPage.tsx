import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { projectsApi, importsApi, sourcesApi, strategiesApi, dedupJobsApi } from "../api/client";
import type { ImportJob, MatchStrategy } from "../api/client";

const PRESET_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "doi_first_strict", label: "DOI + Strict fallback", description: "DOI if available; else title + first author + year" },
  { value: "doi_first_medium", label: "DOI + Medium fallback", description: "DOI if available; else title + year" },
  { value: "strict", label: "Strict (title + author + year)", description: "Ignores DOI; merges on title + first author + year" },
  { value: "medium", label: "Medium (title + year)", description: "Merges on title + year only" },
  { value: "loose", label: "Loose (title + first author)", description: "Merges on title + first author, no year" },
];

function statusBadge(status: ImportJob["status"]) {
  const colors: Record<string, string> = {
    pending: "#888",
    processing: "#1a73e8",
    completed: "#188038",
    failed: "#c5221f",
  };
  return (
    <span style={{ color: colors[status] ?? "#888", fontWeight: 600 }}>
      {status}
    </span>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [newSourceName, setNewSourceName] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("doi_first_strict");
  const [newStrategyName, setNewStrategyName] = useState("");
  const [dedupError, setDedupError] = useState<string | null>(null);

  const { data: project, isLoading: loadingProject } = useQuery({
    queryKey: ["project", id],
    queryFn: () => projectsApi.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: jobs } = useQuery({
    queryKey: ["imports", id],
    queryFn: () => importsApi.list(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const hasActive = data.some((j) => j.status === "pending" || j.status === "processing");
      return hasActive ? 1500 : false;
    },
  });

  const { data: sources } = useQuery({
    queryKey: ["sources", id],
    queryFn: () => sourcesApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: strategies, refetch: refetchStrategies } = useQuery({
    queryKey: ["strategies", id],
    queryFn: () => strategiesApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: dedupJobs, refetch: refetchDedupJobs } = useQuery({
    queryKey: ["dedup-jobs", id],
    queryFn: () => dedupJobsApi.list(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      const hasActive = data.some((j) => j.status === "pending" || j.status === "running");
      return hasActive ? 2000 : false;
    },
  });

  const activeStrategy = strategies?.find((s) => s.is_active);
  const lastDedupJob = dedupJobs?.[0];

  const createStrategy = useMutation({
    mutationFn: ({ name, preset }: { name: string; preset: string }) =>
      strategiesApi.create(id!, name, preset),
    onSuccess: () => {
      refetchStrategies();
      setNewStrategyName("");
      setDedupError(null);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to create strategy";
      setDedupError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  const runDedup = useMutation({
    mutationFn: (strategyId: string) => dedupJobsApi.start(id!, strategyId),
    onSuccess: () => {
      refetchDedupJobs();
      setDedupError(null);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to start dedup job";
      if (typeof detail === "object" && detail.message) {
        setDedupError(detail.message);
      } else {
        setDedupError(typeof detail === "string" ? detail : JSON.stringify(detail));
      }
    },
  });

  const addSource = useMutation({
    mutationFn: (name: string) => sourcesApi.create(id!, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources", id] });
      setNewSourceName("");
      setSourceError(null);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to add source";
      setSourceError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    const name = newSourceName.trim();
    if (!name) return;
    addSource.mutate(name);
  }

  if (loadingProject) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
      </header>
      <main>
        <div className="project-hero">
          <h2>{project?.name}</h2>
          {project?.description && <p>{project.description}</p>}
          <div className="project-stats">
            <span><strong>{project?.record_count ?? 0}</strong> records</span>
            <span><strong>{project?.import_count ?? 0}</strong> imports</span>
          </div>
        </div>

        <div className="action-bar">
          <Link to={`/projects/${id}/import`} className="btn-primary">Import literature</Link>
          {(project?.record_count ?? 0) > 0 && (
            <Link to={`/projects/${id}/records`} className="btn-secondary">View records</Link>
          )}
          {(sources?.length ?? 0) >= 2 && (
            <Link to={`/projects/${id}/overlap`} className="btn-secondary">View overlap</Link>
          )}
        </div>

        {/* Sources section */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Sources</h3>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Tag each imported file with the database it came from (e.g. PubMed, Scopus).
          </p>
          {sources && sources.length > 0 && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
              {sources.map((s) => (
                <span
                  key={s.id}
                  style={{
                    background: "var(--surface-alt, #f1f3f4)",
                    border: "1px solid var(--border, #dadce0)",
                    borderRadius: "1rem",
                    padding: "0.2rem 0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                  }}
                >
                  {s.name}
                </span>
              ))}
            </div>
          )}
          <form onSubmit={handleAddSource} style={{ display: "flex", gap: "0.5rem", maxWidth: 360 }}>
            <input
              type="text"
              className="input"
              placeholder="New source name…"
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={!newSourceName.trim() || addSource.isPending}
            >
              Add
            </button>
          </form>
          {sourceError && <p className="error" style={{ marginTop: "0.5rem" }}>{sourceError}</p>}
        </section>

        {/* Dedup section */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Deduplication</h3>
          {activeStrategy && (
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              Active strategy: <strong>{activeStrategy.name}</strong>{" "}
              <span style={{ color: "#888" }}>({activeStrategy.preset_label})</span>
            </p>
          )}
          {lastDedupJob?.status === "completed" && (
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              Last run:{" "}
              {new Date(lastDedupJob.completed_at!).toLocaleString()} —{" "}
              {lastDedupJob.records_before} → {lastDedupJob.records_after} canonical records
              {lastDedupJob.merges ? ` (${lastDedupJob.merges} merged)` : ""}
            </p>
          )}
          {(lastDedupJob?.status === "pending" || lastDedupJob?.status === "running") && (
            <p style={{ color: "#1a73e8", marginBottom: "0.75rem" }}>
              Deduplication running…
            </p>
          )}

          {/* Strategy selector */}
          <div style={{ marginBottom: "1rem" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.5rem" }}>Select matching preset:</p>
            {PRESET_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "0.4rem", cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="preset"
                  value={opt.value}
                  checked={selectedPreset === opt.value}
                  onChange={() => setSelectedPreset(opt.value)}
                  style={{ marginTop: "0.2rem" }}
                />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="muted" style={{ marginLeft: "0.4rem" }}>{opt.description}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Run dedup — uses active strategy or prompts to create one */}
          {activeStrategy ? (
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              {activeStrategy.preset !== selectedPreset && (
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Strategy name…"
                    value={newStrategyName}
                    onChange={(e) => setNewStrategyName(e.target.value)}
                    style={{ width: 200 }}
                  />
                  <button
                    className="btn-secondary"
                    disabled={!newStrategyName.trim() || createStrategy.isPending}
                    onClick={() => createStrategy.mutate({ name: newStrategyName.trim(), preset: selectedPreset })}
                  >
                    Save &amp; activate
                  </button>
                </div>
              )}
              <button
                className="btn-primary"
                disabled={runDedup.isPending || lastDedupJob?.status === "pending" || lastDedupJob?.status === "running"}
                onClick={() => runDedup.mutate(activeStrategy.id)}
              >
                {(lastDedupJob?.status === "pending" || lastDedupJob?.status === "running") ? "Running…" : "Run deduplication"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="text"
                className="input"
                placeholder="Strategy name…"
                value={newStrategyName}
                onChange={(e) => setNewStrategyName(e.target.value)}
                style={{ width: 200 }}
              />
              <button
                className="btn-primary"
                disabled={!newStrategyName.trim() || createStrategy.isPending}
                onClick={() => createStrategy.mutate({ name: newStrategyName.trim(), preset: selectedPreset })}
              >
                Create strategy
              </button>
            </div>
          )}
          {dedupError && <p className="error" style={{ marginTop: "0.5rem" }}>{dedupError}</p>}
        </section>

        <section style={{ marginTop: "2rem" }}>
          <h3>Import history</h3>
          {!jobs || jobs.length === 0 ? (
            <p className="muted">No imports yet. Upload a RIS file to get started.</p>
          ) : (
            <table className="import-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Records</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const sourceName = job.source_id
                    ? sources?.find((s) => s.id === job.source_id)?.name ?? "—"
                    : "—";
                  return (
                    <tr key={job.id}>
                      <td>{job.filename}</td>
                      <td>{sourceName}</td>
                      <td>{statusBadge(job.status)}</td>
                      <td>{job.record_count ?? "—"}</td>
                      <td>{new Date(job.created_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
