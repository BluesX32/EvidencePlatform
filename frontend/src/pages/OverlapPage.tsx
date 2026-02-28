import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  overlapsApi,
  dedupJobsApi,
  strategiesApi,
  type OverlapClusterDetail,
} from "../api/client";
import OverlapMatrix from "../components/OverlapMatrix";

export default function OverlapPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  // ── Queries ───────────────────────────────────────────────────────────────

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

  const { data: visualData } = useQuery({
    queryKey: ["overlap-visual", projectId],
    queryFn: () => overlapsApi.getVisualSummary(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: clustersData, refetch: refetchClusters } = useQuery({
    queryKey: ["overlap-clusters", projectId, "cross_source"],
    queryFn: () =>
      overlapsApi.listClusters(projectId!, "cross_source", 50, 0).then((r) => r.data),
    enabled: !!projectId,
  });

  // ── State ─────────────────────────────────────────────────────────────────

  const [highlightedPair, setHighlightedPair] = useState<[string, string] | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkRecordIds, setLinkRecordIds] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const manualLink = useMutation({
    mutationFn: () =>
      overlapsApi.manualLink(projectId!, {
        record_ids: linkRecordIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        locked: true,
        note: linkNote || undefined,
      }),
    onSuccess: () => {
      refetchClusters();
      queryClient.invalidateQueries({ queryKey: ["overlap-visual", projectId] });
      setShowLinkForm(false);
      setLinkRecordIds("");
      setLinkNote("");
      setLinkError(null);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Failed to link records";
      setLinkError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const lockCluster = useMutation({
    mutationFn: ({ clusterId, locked }: { clusterId: string; locked: boolean }) =>
      overlapsApi.lockCluster(projectId!, clusterId, { locked }),
    onSuccess: () => refetchClusters(),
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  const lastCompletedDedup = dedupJobs?.find((j) => j.status === "completed");
  const isStale =
    activeStrategy &&
    lastCompletedDedup &&
    lastCompletedDedup.strategy_id !== activeStrategy.id;

  const clusters: OverlapClusterDetail[] = clustersData?.clusters ?? [];

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
                      <th>Total</th>
                      <th>Unique</th>
                      <th>Internal Duplicates</th>
                      <th>With DOI</th>
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
                        <td>{s.unique_count ?? "—"}</td>
                        <td>{s.internal_overlaps ?? "—"}</td>
                        <td>{s.with_doi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* ── Overlap matrix ────────────────────────────────────────────── */}
            {visualData && visualData.sources.length >= 2 && (
              <section style={{ marginBottom: "2rem" }}>
                <h3>Overlap matrix</h3>
                <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  Each cell shows how many cross-source overlap clusters are shared
                  between two sources. Diagonal cells show unique record counts.
                  Click a non-zero cell to highlight that pair.
                </p>
                <OverlapMatrix
                  data={visualData}
                  highlightPair={highlightedPair}
                  onCellClick={(a, b) =>
                    setHighlightedPair((prev) =>
                      prev?.[0] === a && prev?.[1] === b ? null : [a, b]
                    )
                  }
                />
                {highlightedPair && (
                  <p
                    style={{ marginTop: "0.4rem", fontSize: "0.82rem", color: "#5f6368" }}
                  >
                    Highlighted:{" "}
                    <strong>
                      {visualData.sources.find((s) => s.id === highlightedPair[0])?.name}
                    </strong>{" "}
                    ∩{" "}
                    <strong>
                      {visualData.sources.find((s) => s.id === highlightedPair[1])?.name}
                    </strong>
                    {"  "}
                    <button
                      onClick={() => setHighlightedPair(null)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#1a73e8",
                        fontSize: "0.82rem",
                        padding: 0,
                      }}
                    >
                      Clear
                    </button>
                  </p>
                )}
              </section>
            )}

            {/* ── Cross-source overlap clusters ─────────────────────────────── */}
            <section style={{ marginBottom: "2rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "1rem",
                  marginBottom: "0.75rem",
                }}
              >
                <h3 style={{ margin: 0 }}>Cross-source clusters</h3>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "0.82rem", padding: "0.25rem 0.6rem" }}
                  onClick={() => setShowLinkForm((v) => !v)}
                >
                  {showLinkForm ? "Cancel" : "+ Link records manually"}
                </button>
              </div>

              {showLinkForm && (
                <div
                  style={{
                    background: "#f8f9fa",
                    border: "1px solid #dadce0",
                    borderRadius: "0.375rem",
                    padding: "0.75rem 1rem",
                    marginBottom: "1rem",
                    maxWidth: 520,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "#3c4043" }}>
                    Enter comma-separated <strong>record_source IDs</strong> to link
                    into a new locked overlap group.
                  </p>
                  <input
                    className="input"
                    placeholder="ID1, ID2, ID3…"
                    value={linkRecordIds}
                    onChange={(e) => setLinkRecordIds(e.target.value)}
                    style={{ fontFamily: "monospace", fontSize: "0.82rem" }}
                  />
                  <input
                    className="input"
                    placeholder="Note (optional)"
                    value={linkNote}
                    onChange={(e) => setLinkNote(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button
                      className="btn-primary"
                      disabled={!linkRecordIds.trim() || manualLink.isPending}
                      onClick={() => manualLink.mutate()}
                      style={{ fontSize: "0.85rem" }}
                    >
                      {manualLink.isPending ? "Linking…" : "Link"}
                    </button>
                    {linkError && (
                      <span style={{ color: "#c5221f", fontSize: "0.82rem" }}>
                        {linkError}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {clusters.length === 0 ? (
                <p className="muted">
                  No cross-source overlap clusters yet. Run overlap detection to
                  detect shared records, or link records manually above.
                </p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Sources</th>
                      <th>Members</th>
                      <th>Tier / Basis</th>
                      <th>Origin</th>
                      <th>Locked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clusters.map((c) => (
                      <ClusterRow
                        key={c.cluster_id}
                        cluster={c}
                        onToggleLock={(locked) =>
                          lockCluster.mutate({ clusterId: c.cluster_id, locked })
                        }
                        highlightedPair={highlightedPair}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* ── Pairwise overlap (from dedup linkage) ─────────────────────── */}
            <section>
              <h3>Pairwise record overlap</h3>
              <p className="muted" style={{ marginBottom: "0.75rem" }}>
                Number of canonical records shared by each pair of sources, as
                determined by the active dedup strategy.
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
// ClusterRow sub-component
// ---------------------------------------------------------------------------

function ClusterRow({
  cluster,
  onToggleLock,
  highlightedPair,
}: {
  cluster: OverlapClusterDetail;
  onToggleLock: (locked: boolean) => void;
  highlightedPair: [string, string] | null;
}) {
  const sourceNames = cluster.members
    .map((m) => m.source_name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const clusterSourceIds = cluster.members
    .map((m) => m.source_id)
    .filter((v, i, a) => a.indexOf(v) === i);

  const isHighlighted =
    highlightedPair !== null &&
    clusterSourceIds.includes(highlightedPair[0]) &&
    clusterSourceIds.includes(highlightedPair[1]);

  return (
    <tr
      style={{
        background: isHighlighted ? "#fce8e6" : undefined,
        outline: isHighlighted ? "2px solid #ea4335" : undefined,
      }}
    >
      <td style={{ fontSize: "0.83rem" }}>{sourceNames}</td>
      <td>{cluster.member_count}</td>
      <td style={{ fontSize: "0.8rem", color: "#5f6368" }}>
        {cluster.match_tier === 0 ? "—" : `Tier ${cluster.match_tier}`} /{" "}
        {cluster.match_basis}
      </td>
      <td>
        <OriginBadge origin={cluster.origin} />
      </td>
      <td>
        <button
          title={cluster.locked ? "Locked — click to unlock" : "Unlocked — click to lock"}
          onClick={() => onToggleLock(!cluster.locked)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "1rem",
            padding: "0.1rem",
            lineHeight: 1,
            color: cluster.locked ? "#1a73e8" : "#aaa",
          }}
        >
          {cluster.locked ? "🔒" : "🔓"}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// OriginBadge sub-component
// ---------------------------------------------------------------------------

function OriginBadge({ origin }: { origin: string }) {
  const styles: Record<string, { color: string; bg: string; border: string; label: string }> = {
    auto: { color: "#5f6368", bg: "#f1f3f4", border: "#dadce0", label: "Auto" },
    manual: { color: "#1a73e8", bg: "#e8f0fe", border: "#c5d9f7", label: "Manual" },
    mixed: { color: "#e37400", bg: "#fef7e0", border: "#f9ab00", label: "Mixed" },
  };
  const s = styles[origin] ?? styles.auto;
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.7rem",
        fontWeight: 600,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: "0.25rem",
        padding: "0.1rem 0.35rem",
        letterSpacing: "0.02em",
        textTransform: "capitalize",
      }}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SummaryCard sub-component
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
