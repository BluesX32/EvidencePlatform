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
      overlapsApi.listClusters(projectId!, "cross_source", 200, 0).then((r) => r.data),
    enabled: !!projectId,
  });

  // ── State ─────────────────────────────────────────────────────────────────

  const [highlightedPair, setHighlightedPair] = useState<[string, string] | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkRecordIds, setLinkRecordIds] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  // Cluster list filters
  const [originFilter, setOriginFilter] = useState<"all" | "auto" | "manual" | "mixed">("all");
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  const [minSourcesFilter, setMinSourcesFilter] = useState(0);
  const [selectedIntersection, setSelectedIntersection] = useState<string[] | null>(null);

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

  const allClusters: OverlapClusterDetail[] = clustersData?.clusters ?? [];

  // Sort: member count desc, then source count desc
  const sortedClusters = [...allClusters].sort((a, b) => {
    const byMembers = b.member_count - a.member_count;
    if (byMembers !== 0) return byMembers;
    const aS = new Set(a.members.map((m) => m.source_id)).size;
    const bS = new Set(b.members.map((m) => m.source_id)).size;
    return bS - aS;
  });

  // Apply filters
  const filteredClusters = sortedClusters.filter((c) => {
    if (originFilter !== "all" && c.origin !== originFilter) return false;
    if (showPinnedOnly && !c.locked) return false;
    const clusterSourceIds = new Set(c.members.map((m) => m.source_id));
    if (minSourcesFilter > 0 && clusterSourceIds.size < minSourcesFilter) return false;
    if (selectedIntersection !== null) {
      const matchesAll = selectedIntersection.every((sid) => clusterSourceIds.has(sid));
      const exactMatch = clusterSourceIds.size === selectedIntersection.length;
      if (!matchesAll || !exactMatch) return false;
    }
    return true;
  });

  // Top intersections from visual data
  const topIntersections = visualData?.top_intersections ?? [];

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

            {/* ── Multi-source intersections ────────────────────────────────── */}
            {topIntersections.length > 0 && (
              <section style={{ marginBottom: "2rem" }}>
                <h3>Multi-source intersections</h3>
                <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  Shows the most frequent source combinations among overlap clusters.
                  Useful to understand how many papers appear across 3+ databases.
                  Click a bar to filter the cluster list below to that combination.
                </p>
                <IntersectionsChart
                  intersections={topIntersections}
                  selectedIds={selectedIntersection}
                  onSelect={(ids) =>
                    setSelectedIntersection((prev) =>
                      prev !== null &&
                      prev.length === ids.length &&
                      ids.every((id) => prev.includes(id))
                        ? null
                        : ids
                    )
                  }
                />
                {selectedIntersection !== null && (
                  <p style={{ marginTop: "0.4rem", fontSize: "0.82rem", color: "#5f6368" }}>
                    Filtering clusters by this combination.{" "}
                    <button
                      onClick={() => setSelectedIntersection(null)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#1a73e8",
                        fontSize: "0.82rem",
                        padding: 0,
                      }}
                    >
                      Clear filter
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
                  marginBottom: "0.5rem",
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

              <p className="muted" style={{ marginBottom: "0.75rem", fontSize: "0.85rem" }}>
                Each row is one overlap cluster — one "paper identity" containing member
                records from multiple sources. Multiple clusters can share the same source
                combination; each represents a distinct paper.
              </p>

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
                    into a new pinned overlap group.
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

              {/* Filter chips */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.4rem",
                  marginBottom: "0.75rem",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "0.8rem", color: "#5f6368", marginRight: "0.2rem" }}>
                  Origin:
                </span>
                {(["all", "auto", "manual", "mixed"] as const).map((f) => (
                  <FilterChip
                    key={f}
                    label={f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                    active={originFilter === f}
                    onClick={() => setOriginFilter(f)}
                  />
                ))}
                <span
                  style={{
                    width: 1,
                    height: 18,
                    background: "#dadce0",
                    display: "inline-block",
                    margin: "0 0.3rem",
                  }}
                />
                <FilterChip
                  label="Pinned only"
                  active={showPinnedOnly}
                  onClick={() => setShowPinnedOnly((v) => !v)}
                />
                <FilterChip
                  label="3+ sources"
                  active={minSourcesFilter >= 3}
                  onClick={() => setMinSourcesFilter((v) => (v >= 3 ? 0 : 3))}
                />
                {(originFilter !== "all" || showPinnedOnly || minSourcesFilter >= 3 || selectedIntersection !== null) && (
                  <button
                    onClick={() => {
                      setOriginFilter("all");
                      setShowPinnedOnly(false);
                      setMinSourcesFilter(0);
                      setSelectedIntersection(null);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#c5221f",
                      fontSize: "0.8rem",
                      padding: "0.1rem 0.3rem",
                    }}
                  >
                    ✕ Clear all filters
                  </button>
                )}
              </div>

              {filteredClusters.length === 0 && allClusters.length === 0 ? (
                <p className="muted">
                  No cross-source overlap clusters yet. Run overlap detection to
                  detect shared records, or link records manually above.
                </p>
              ) : filteredClusters.length === 0 ? (
                <p className="muted">No clusters match the current filters.</p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th>Sources</th>
                      <th>Members</th>
                      <th>Tier / Basis</th>
                      <th>Origin</th>
                      <th title="Pinned clusters are preserved across re-runs">Pinned</th>
                      <th style={{ color: "#80868b", fontWeight: 400, fontSize: "0.75rem" }}>
                        ID
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClusters.map((c) => (
                      <ClusterRow
                        key={c.cluster_id}
                        cluster={c}
                        onToggleLock={(locked) =>
                          lockCluster.mutate({ clusterId: c.cluster_id, locked })
                        }
                        highlightedPair={highlightedPair}
                        selectedIntersection={selectedIntersection}
                      />
                    ))}
                  </tbody>
                </table>
              )}
              {filteredClusters.length > 0 && allClusters.length > filteredClusters.length && (
                <p style={{ fontSize: "0.8rem", color: "#80868b", marginTop: "0.4rem" }}>
                  Showing {filteredClusters.length} of {allClusters.length} clusters.
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntersectionsChart sub-component — horizontal bar chart
// ---------------------------------------------------------------------------

function IntersectionsChart({
  intersections,
  selectedIds,
  onSelect,
}: {
  intersections: { source_ids: string[]; source_names: string[]; count: number }[];
  selectedIds: string[] | null;
  onSelect: (ids: string[]) => void;
}) {
  const maxCount = intersections[0]?.count ?? 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxWidth: 640 }}>
      {intersections.map((item, i) => {
        const label = [...item.source_names].sort().join(" + ");
        const widthPct = (item.count / maxCount) * 100;
        const isSelected =
          selectedIds !== null &&
          selectedIds.length === item.source_ids.length &&
          item.source_ids.every((id) => selectedIds.includes(id));

        return (
          <div
            key={i}
            onClick={() => onSelect(item.source_ids)}
            title={`Click to ${isSelected ? "clear" : "filter clusters to"}: ${label}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              cursor: "pointer",
              padding: "0.25rem 0.4rem",
              borderRadius: "0.25rem",
              background: isSelected ? "#e8f0fe" : "transparent",
              border: isSelected ? "1px solid #c5d9f7" : "1px solid transparent",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                color: "#3c4043",
                minWidth: 200,
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
              title={label}
            >
              {label}
            </span>
            <div
              style={{
                flexGrow: 1,
                height: 14,
                background: "#f1f3f4",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: "100%",
                  background: isSelected ? "#1a73e8" : "#c5d9f7",
                  borderRadius: 3,
                  transition: "width 0.15s",
                }}
              />
            </div>
            <span
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                color: isSelected ? "#1a73e8" : "#3c4043",
                minWidth: 28,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {item.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterChip sub-component
// ---------------------------------------------------------------------------

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: "0.78rem",
        fontWeight: active ? 600 : 400,
        padding: "0.15rem 0.55rem",
        borderRadius: "1rem",
        border: `1px solid ${active ? "#1a73e8" : "#dadce0"}`,
        background: active ? "#e8f0fe" : "transparent",
        color: active ? "#1a73e8" : "#5f6368",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ClusterRow sub-component
// ---------------------------------------------------------------------------

function ClusterRow({
  cluster,
  onToggleLock,
  highlightedPair,
  selectedIntersection,
}: {
  cluster: OverlapClusterDetail;
  onToggleLock: (locked: boolean) => void;
  highlightedPair: [string, string] | null;
  selectedIntersection: string[] | null;
}) {
  const sourceNames = cluster.members
    .map((m) => m.source_name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const clusterSourceIds = cluster.members
    .map((m) => m.source_id)
    .filter((v, i, a) => a.indexOf(v) === i);

  const isHighlightedByPair =
    highlightedPair !== null &&
    clusterSourceIds.includes(highlightedPair[0]) &&
    clusterSourceIds.includes(highlightedPair[1]);

  const isHighlightedByIntersection =
    selectedIntersection !== null &&
    selectedIntersection.length === clusterSourceIds.length &&
    selectedIntersection.every((id) => clusterSourceIds.includes(id));

  const isHighlighted = isHighlightedByPair || isHighlightedByIntersection;

  const shortId = cluster.cluster_id.slice(-6);

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
          title={
            cluster.locked
              ? "Pinned — this cluster is preserved across re-runs. Click to unpin."
              : "Not pinned — may be replaced on re-run. Click to pin."
          }
          onClick={() => onToggleLock(!cluster.locked)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "0.15rem",
            lineHeight: 1,
            color: cluster.locked ? "#1a73e8" : "#bdc1c6",
            display: "flex",
            alignItems: "center",
          }}
        >
          <PinIcon pinned={cluster.locked} />
        </button>
      </td>
      <td
        style={{
          fontFamily: "monospace",
          fontSize: "0.72rem",
          color: "#80868b",
          letterSpacing: "0.03em",
        }}
      >
        …{shortId}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// PinIcon sub-component — thumbtack SVG
// ---------------------------------------------------------------------------

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      {pinned ? (
        /* Filled thumbtack — pinned */
        <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
      ) : (
        /* Outline thumbtack — not pinned */
        <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
      )}
    </svg>
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
