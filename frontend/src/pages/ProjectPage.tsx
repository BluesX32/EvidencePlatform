import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  projectsApi,
  importsApi,
  sourcesApi,
  strategiesApi,
  dedupJobsApi,
  overlapsApi,
  DEFAULT_OVERLAP_CONFIG,
} from "../api/client";
import type { ImportJob, OverlapConfig } from "../api/client";

// ---------------------------------------------------------------------------
// Field chip definitions for the overlap strategy builder (9 fields)
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  description: string;
}

const FIELD_DEFS: FieldDef[] = [
  { key: "doi",          label: "DOI",          description: "Match on exact Digital Object Identifier" },
  { key: "pmid",         label: "PubMed ID",    description: "Match on exact PubMed / MEDLINE accession number" },
  { key: "title",        label: "Title",        description: "Match on normalized title" },
  { key: "year",         label: "Year",         description: "Match on publication year" },
  { key: "first_author", label: "First Author", description: "Match on first author last name" },
  { key: "all_authors",  label: "All Authors",  description: "Match on all author last names (requires at least one shared)" },
  { key: "volume",       label: "Volume",       description: "Match on journal volume number" },
  { key: "pages",        label: "Pages",        description: "Match on page range" },
  { key: "journal",      label: "Journal",      description: "Match on journal name" },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

function FieldChip({
  fieldDef,
  enabled,
  onChange,
}: {
  fieldDef: FieldDef;
  enabled: boolean;
  onChange: (key: string, value: boolean) => void;
}) {
  return (
    <button
      type="button"
      title={fieldDef.description}
      onClick={() => onChange(fieldDef.key, !enabled)}
      style={{
        padding: "0.3rem 0.8rem",
        borderRadius: "1rem",
        border: `2px solid ${enabled ? "#1a73e8" : "#dadce0"}`,
        background: enabled ? "#e8f0fe" : "#f8f9fa",
        color: enabled ? "#1a73e8" : "#5f6368",
        fontWeight: enabled ? 600 : 400,
        fontSize: "0.85rem",
        cursor: "pointer",
        transition: "all 0.12s",
      }}
    >
      {fieldDef.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [newSourceName, setNewSourceName] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  // Strategy builder state
  const [selectedFields, setSelectedFields] = useState<Set<string>>(
    new Set(DEFAULT_OVERLAP_CONFIG.selected_fields)
  );
  const [fuzzyEnabled, setFuzzyEnabled] = useState(DEFAULT_OVERLAP_CONFIG.fuzzy_enabled);
  const [fuzzyThreshold, setFuzzyThreshold] = useState(DEFAULT_OVERLAP_CONFIG.fuzzy_threshold);
  const [yearTolerance, setYearTolerance] = useState(DEFAULT_OVERLAP_CONFIG.year_tolerance);
  const [newStrategyName, setNewStrategyName] = useState("");
  const [overlapError, setOverlapError] = useState<string | null>(null);

  // ── Data queries ──────────────────────────────────────────────────────────

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
      return data.some((j) => j.status === "pending" || j.status === "processing")
        ? 1500
        : false;
    },
  });

  const { data: sources } = useQuery({
    queryKey: ["sources", id],
    queryFn: () => sourcesApi.list(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: strategies } = useQuery({
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
      return data.some((j) => j.status === "pending" || j.status === "running")
        ? 2000
        : false;
    },
  });

  const activeStrategy = strategies?.find((s) => s.is_active);
  const lastDedupJob = dedupJobs?.[0];
  const isJobRunning =
    lastDedupJob?.status === "pending" || lastDedupJob?.status === "running";

  const enabledFieldCount = selectedFields.size;

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createStrategy = useMutation({
    mutationFn: ({ name, overlapConfig }: { name: string; overlapConfig: OverlapConfig }) =>
      strategiesApi.create(id!, name, "custom", true, null, overlapConfig),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategies", id] });
      queryClient.invalidateQueries({ queryKey: ["strategies-active", id] });
      setNewStrategyName("");
      setOverlapError(null);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to create strategy";
      setOverlapError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  const runOverlapDetection = useMutation({
    mutationFn: (strategyId: string) => overlapsApi.run(id!, strategyId),
    onSuccess: () => {
      refetchDedupJobs();
      queryClient.invalidateQueries({ queryKey: ["project", id] });
      queryClient.invalidateQueries({ queryKey: ["overlap", id] });
      setOverlapError(null);
    },
    onError: (err: any) => {
      const detail =
        err.response?.data?.detail ?? "Failed to start overlap detection";
      setOverlapError(
        typeof detail === "object" && detail.message
          ? detail.message
          : typeof detail === "string"
          ? detail
          : JSON.stringify(detail)
      );
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

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    const name = newSourceName.trim();
    if (!name) return;
    addSource.mutate(name);
  }

  function handleFieldToggle(key: string, value: boolean) {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleRunOverlap() {
    if (activeStrategy) runOverlapDetection.mutate(activeStrategy.id);
  }

  function handleSaveAndRun() {
    const name = newStrategyName.trim();
    if (!name) return;
    const overlapConfig: OverlapConfig = {
      selected_fields: Array.from(selectedFields),
      fuzzy_enabled: fuzzyEnabled,
      fuzzy_threshold: fuzzyThreshold,
      year_tolerance: yearTolerance,
    };
    createStrategy.mutate({ name, overlapConfig });
  }

  // ── Render ────────────────────────────────────────────────────────────────

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
            <span title="Canonical records after overlap resolution">
              <strong>{project?.record_count ?? 0}</strong> records
            </span>
            <span title="Completed import jobs">
              <strong>{project?.import_count ?? 0}</strong> imports
            </span>
            {(project?.failed_import_count ?? 0) > 0 && (
              <span style={{ color: "#c5221f" }}>
                <strong>{project.failed_import_count}</strong> failed
              </span>
            )}
          </div>
        </div>

        <div className="action-bar">
          <Link to={`/projects/${id}/import`} className="btn-primary">
            Import literature
          </Link>
          {(project?.record_count ?? 0) > 0 && (
            <Link to={`/projects/${id}/records`} className="btn-secondary">
              View records
            </Link>
          )}
          {(sources?.length ?? 0) >= 2 && (
            <Link to={`/projects/${id}/overlap`} className="btn-secondary">
              Overlap Resolution
            </Link>
          )}
        </div>

        {/* ── Sources ──────────────────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Sources</h3>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Tag each imported file with the database it came from (e.g. PubMed, Scopus).
          </p>
          {sources && sources.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginBottom: "1rem",
              }}
            >
              {sources.map((s) => (
                <Link
                  key={s.id}
                  to={`/projects/${id}/records?source_id=${s.id}`}
                  style={{
                    background: "var(--surface-alt, #f1f3f4)",
                    border: "1px solid var(--border, #dadce0)",
                    borderRadius: "1rem",
                    padding: "0.2rem 0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          )}
          <form
            onSubmit={handleAddSource}
            style={{ display: "flex", gap: "0.5rem", maxWidth: 360 }}
          >
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
          {sourceError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {sourceError}
            </p>
          )}
        </section>

        {/* ── Overlap Resolution ───────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Overlap Resolution</h3>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            Detect duplicate records within a single source and the same paper
            appearing across multiple databases. Select the matching fields below
            to control how overlaps are identified.
          </p>

          {/* Active strategy pill */}
          {activeStrategy && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                background: "#e8f0fe",
                border: "1px solid #c5d9f7",
                borderRadius: "0.5rem",
                padding: "0.4rem 0.85rem",
                marginBottom: "1rem",
                fontSize: "0.875rem",
              }}
            >
              <span style={{ color: "#1a73e8", fontWeight: 600 }}>Active:</span>
              <span>{activeStrategy.name}</span>
              {activeStrategy.preset !== "custom" && (
                <span className="muted">({activeStrategy.preset_label})</span>
              )}
            </div>
          )}

          {/* Last run status */}
          {lastDedupJob?.status === "completed" && (
            <p className="muted" style={{ marginBottom: "0.75rem", fontSize: "0.9rem" }}>
              Last run:{" "}
              {new Date(lastDedupJob.completed_at!).toLocaleString()} —{" "}
              {lastDedupJob.clusters_created ?? 0} overlap groups detected
              {(lastDedupJob.merges ?? 0) > 0 &&
                ` (${lastDedupJob.merges} duplicates resolved)`}
            </p>
          )}
          {isJobRunning && (
            <p style={{ color: "#1a73e8", marginBottom: "0.75rem" }}>
              Overlap detection running…
            </p>
          )}

          {/* Strategy builder — field chip selector */}
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ fontWeight: 500, marginBottom: "0.5rem", fontSize: "0.9rem" }}>
              Matching rules{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                (toggle fields used to identify overlaps):
              </span>
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginBottom: "0.75rem",
              }}
            >
              {FIELD_DEFS.map((fd) => (
                <FieldChip
                  key={fd.key}
                  fieldDef={fd}
                  enabled={selectedFields.has(fd.key)}
                  onChange={handleFieldToggle}
                />
              ))}
            </div>

            {/* Fuzzy matching toggle + options */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                marginTop: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  color: "#5f6368",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={fuzzyEnabled}
                  onChange={(e) => setFuzzyEnabled(e.target.checked)}
                />
                Fuzzy title matching
              </label>
              {fuzzyEnabled && (
                <label style={{ color: "#5f6368", display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                  Similarity threshold:
                  <input
                    type="range"
                    min={0.7}
                    max={1.0}
                    step={0.01}
                    value={fuzzyThreshold}
                    onChange={(e) => setFuzzyThreshold(parseFloat(e.target.value))}
                    style={{ width: 100 }}
                  />
                  <strong>{Math.round(fuzzyThreshold * 100)}%</strong>
                </label>
              )}
              <label style={{ color: "#5f6368", fontSize: "0.85rem" }}>
                Year:&nbsp;
                <select
                  value={yearTolerance}
                  onChange={(e) => setYearTolerance(parseInt(e.target.value, 10))}
                  style={{ fontSize: "0.85rem" }}
                >
                  <option value={0}>Exact year</option>
                  <option value={1}>Allow ±1 year</option>
                </select>
              </label>
            </div>
          </div>

          {/* Action buttons */}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {activeStrategy && (
              <button
                className="btn-primary"
                disabled={
                  isJobRunning ||
                  runOverlapDetection.isPending ||
                  enabledFieldCount === 0
                }
                onClick={handleRunOverlap}
                title="Run overlap detection with the active strategy"
              >
                {isJobRunning ? "Running…" : "Run overlap detection"}
              </button>
            )}

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="text"
                className="input"
                placeholder="Strategy name…"
                value={newStrategyName}
                onChange={(e) => setNewStrategyName(e.target.value)}
                style={{ width: 190 }}
              />
              <button
                className={activeStrategy ? "btn-secondary" : "btn-primary"}
                disabled={
                  !newStrategyName.trim() ||
                  createStrategy.isPending ||
                  enabledFieldCount === 0
                }
                onClick={handleSaveAndRun}
                title="Save these rules as a new strategy and activate it"
              >
                Save &amp; activate
              </button>
            </div>
          </div>

          {enabledFieldCount === 0 && (
            <p
              className="muted"
              style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "#c5221f" }}
            >
              Select at least one matching field to enable overlap detection.
            </p>
          )}
          {overlapError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {overlapError}
            </p>
          )}

          {/* Link to full overlap report */}
          {(sources?.length ?? 0) >= 2 && (
            <p style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
              <Link
                to={`/projects/${id}/overlap`}
                style={{ color: "#1a73e8", textDecoration: "none" }}
              >
                View full Overlap Resolution report →
              </Link>
            </p>
          )}
        </section>

        {/* ── Import history ───────────────────────────────────────────────── */}
        <section style={{ marginTop: "2rem" }}>
          <h3>Import history</h3>
          {!jobs || jobs.length === 0 ? (
            <p className="muted">No imports yet. Upload a RIS or MEDLINE file to get started.</p>
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
