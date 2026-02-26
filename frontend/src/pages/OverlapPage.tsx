import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { overlapsApi, dedupJobsApi, strategiesApi } from "../api/client";

export default function OverlapPage() {
  const { id: projectId } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["overlap", projectId],
    queryFn: () => overlapsApi.getSummary(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: dedupJobs } = useQuery({
    queryKey: ["dedup-jobs", projectId],
    queryFn: () => dedupJobsApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: activeStrategy } = useQuery({
    queryKey: ["strategies-active", projectId],
    queryFn: () => strategiesApi.getActive(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const lastCompletedDedup = dedupJobs?.find((j) => j.status === "completed");
  const isStale =
    activeStrategy &&
    lastCompletedDedup &&
    lastCompletedDedup.strategy_id !== activeStrategy.id;

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          ← Project
        </Link>
      </header>
      <main>
        <h2>Overlap Resolution</h2>
        {data?.strategy_name && (
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            Last run with strategy: <strong>{data.strategy_name}</strong>
          </p>
        )}

        {isStale && (
          <div
            style={{
              background: "#fef7e0",
              border: "1px solid #f9ab00",
              borderRadius: "0.375rem",
              padding: "0.6rem 1rem",
              marginBottom: "1rem",
              color: "#7a5200",
              fontSize: "0.9rem",
            }}
          >
            Strategy changed since last run. Go to the Project page and run
            overlap detection again to refresh these results.
          </div>
        )}

        {!data && !isLoading && (
          <div
            style={{
              background: "#f8f9fa",
              border: "1px solid #dadce0",
              borderRadius: "0.5rem",
              padding: "1rem",
              marginBottom: "1.5rem",
              color: "#5f6368",
            }}
          >
            No overlap data yet. Run overlap detection from the Project page to
            populate this report.
          </div>
        )}

        {isLoading && <p>Loading…</p>}
        {error && <p className="error">Failed to load overlap data.</p>}

        {data && (
          <>
            {/* ── Summary cards ─────────────────────────────────────────────── */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "1rem",
                marginBottom: "2rem",
              }}
            >
              <SummaryCard
                title="Within-Source Duplicates"
                value={data.within_source.duplicate_record_count}
                subtitle={`${data.within_source.cluster_count} duplicate groups`}
                description="Records that appeared more than once in a single source file"
                color="#e8f0fe"
                border="#c5d9f7"
              />
              <SummaryCard
                title="Cross-Source Overlaps"
                value={data.cross_source.cluster_count}
                subtitle="unique papers in multiple databases"
                description="The same article found in records from two or more sources"
                color="#e6f4ea"
                border="#b7dfc4"
              />
            </div>

            {/* ── Per-source totals ─────────────────────────────────────────── */}
            <section style={{ marginBottom: "2rem" }}>
              <h3>Per-source totals</h3>
              {data.sources.length === 0 ? (
                <p className="muted">No sources found for this project.</p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Total records</th>
                      <th>With DOI</th>
                      <th>Without DOI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link
                            to={`/projects/${projectId}/records?source_id=${s.id}`}
                            style={{
                              textDecoration: "none",
                              color: "var(--primary, #1a73e8)",
                            }}
                          >
                            {s.name}
                          </Link>
                        </td>
                        <td>{s.total}</td>
                        <td>{s.with_doi}</td>
                        <td>{s.total - s.with_doi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* ── Pairwise overlap ──────────────────────────────────────────── */}
            <section>
              <h3>Cross-source overlap</h3>
              <p className="muted" style={{ marginBottom: "0.75rem" }}>
                Number of canonical records shared by each pair of sources, as
                determined by the active overlap resolution strategy.
              </p>
              {data.pairs.length === 0 ? (
                <p className="muted">
                  {data.sources.length < 2
                    ? "Import from at least two sources to see overlap."
                    : "No shared records found between any pair of sources."}
                </p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Source A</th>
                      <th>Source B</th>
                      <th>Shared records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pairs.map((p) => (
                      <tr key={`${p.source_a_id}-${p.source_b_id}`}>
                        <td>{p.source_a_name}</td>
                        <td>{p.source_b_name}</td>
                        <td>
                          <strong>{p.shared_records}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary card sub-component
// ---------------------------------------------------------------------------

function SummaryCard({
  title,
  value,
  subtitle,
  description,
  color,
  border,
}: {
  title: string;
  value: number;
  subtitle: string;
  description: string;
  color: string;
  border: string;
}) {
  return (
    <div
      style={{
        background: color,
        border: `1px solid ${border}`,
        borderRadius: "0.5rem",
        padding: "1rem 1.25rem",
      }}
    >
      <p
        style={{
          fontSize: "0.8rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "#5f6368",
          marginBottom: "0.25rem",
        }}
      >
        {title}
      </p>
      <p style={{ fontSize: "2rem", fontWeight: 700, margin: "0 0 0.1rem" }}>
        {value}
      </p>
      <p style={{ fontSize: "0.8rem", color: "#5f6368", margin: 0 }}>
        {subtitle}
      </p>
      <p
        style={{
          fontSize: "0.78rem",
          color: "#80868b",
          marginTop: "0.4rem",
          lineHeight: 1.4,
        }}
      >
        {description}
      </p>
    </div>
  );
}
