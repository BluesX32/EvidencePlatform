import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  overlapsApi,
  dedupJobsApi,
  strategiesApi,
  type OverlapClusterDetail,
  type OverlapClusterMemberDetail,
} from "../api/client";
import OverlapMatrix from "../components/OverlapMatrix";
import EulerDiagram, { SOURCE_COLORS } from "../components/EulerDiagram";

// ── Human-readable match evidence labels ─────────────────────────────────────

function evidenceLabel(tier: number): string {
  switch (tier) {
    case 0: return "Manual link";
    case 1: return "Exact ID (DOI/PMID)";
    case 2: return "Title · Year · Author · Volume";
    case 3: return "Title · Year · Author";
    case 4: return "Title · Year";
    case 5: return "Fuzzy title";
    default: return `Tier ${tier}`;
  }
}

// ── Pagination controls ───────────────────────────────────────────────────────

function PaginationStrip({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (ps: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.6rem",
        alignItems: "center",
        flexWrap: "wrap",
        margin: "0.5rem 0",
        fontSize: "0.85rem",
        color: "#3c4043",
      }}
    >
      <button
        className="btn-secondary"
        style={{ padding: "0.2rem 0.7rem", fontSize: "0.82rem" }}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        ← Prev
      </button>

      <span>
        Page <strong>{page}</strong> / {totalPages}
      </span>

      <button
        className="btn-secondary"
        style={{ padding: "0.2rem 0.7rem", fontSize: "0.82rem" }}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        Next →
      </button>

      <span style={{ marginLeft: "0.4rem", color: "#80868b" }}>
        {totalItems.toLocaleString()} paper groups total
      </span>

      <label
        style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.35rem" }}
      >
        <span style={{ color: "#5f6368" }}>Per page:</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          style={{
            fontSize: "0.82rem",
            padding: "0.15rem 0.4rem",
            border: "1px solid #dadce0",
            borderRadius: "0.25rem",
            background: "#fff",
          }}
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </label>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

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

  // ── State ─────────────────────────────────────────────────────────────────

  const [highlightedPair, setHighlightedPair]     = useState<[string, string] | null>(null);
  const [showLinkForm, setShowLinkForm]           = useState(false);
  const [linkRecordIds, setLinkRecordIds]         = useState("");
  const [linkNote, setLinkNote]                   = useState("");
  const [linkError, setLinkError]                 = useState<string | null>(null);

  // Euler map + cluster list filter
  const [selectedSourceId, setSelectedSourceId]   = useState<string | null>(null);
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);

  // Cluster list filter chips (all server-side)
  const [originFilter, setOriginFilter]         = useState<"all" | "auto" | "manual" | "mixed">("all");
  const [showPinnedOnly, setShowPinnedOnly]     = useState(false);
  const [minSourcesFilter, setMinSourcesFilter] = useState(0);

  // Pagination
  const [clusterPage, setClusterPage]         = useState(1);
  const [clusterPageSize, setClusterPageSize] = useState(50);

  // Reset to page 1 whenever any filter changes
  useEffect(() => {
    setClusterPage(1);
  }, [originFilter, showPinnedOnly, minSourcesFilter, selectedSourceId]);

  // ── Clusters query (server-side filtered + paginated) ─────────────────────

  const { data: clustersData, refetch: refetchClusters } = useQuery({
    queryKey: [
      "overlap-clusters", projectId,
      clusterPage, clusterPageSize,
      originFilter, showPinnedOnly, minSourcesFilter, selectedSourceId,
    ],
    queryFn: () =>
      overlapsApi.listClusters(projectId!, {
        scope: "cross_source",
        page: clusterPage,
        page_size: clusterPageSize,
        source_id: selectedSourceId ?? undefined,
        origin: originFilter !== "all" ? originFilter : undefined,
        locked: showPinnedOnly ? true : undefined,
        min_sources: minSourcesFilter > 0 ? minSourcesFilter : undefined,
      }).then((r) => r.data),
    enabled: !!projectId,
  });

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
      setClusterPage(1);
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

  // Stable color map: source_id → hex color (matches EulerDiagram colours)
  const sourceColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    (visualData?.sources ?? []).forEach((s, i) => {
      map[s.id] = SOURCE_COLORS[i % SOURCE_COLORS.length];
    });
    return map;
  }, [visualData?.sources]);

  const allClusters: OverlapClusterDetail[] = clustersData?.clusters ?? [];
  const totalItems  = clustersData?.total_items ?? 0;
  const totalPages  = clustersData?.total_pages ?? 1;

  const hasActiveFilter =
    originFilter !== "all" || showPinnedOnly || minSourcesFilter >= 3 || selectedSourceId !== null;

  const paginationProps = {
    page: clusterPage,
    totalPages,
    totalItems,
    pageSize: clusterPageSize,
    onPageChange: setClusterPage,
    onPageSizeChange: (ps: number) => { setClusterPageSize(ps); setClusterPage(1); },
  };

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

        {!data && !isLoading && !error && (
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
                subtitle="paper groups spanning multiple databases"
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
                            style={{ textDecoration: "none", color: "var(--primary, #1a73e8)" }}
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

            {/* ── Overlap map (Euler diagram) ───────────────────────────────── */}
            {visualData && visualData.sources.length >= 2 && (
              <section style={{ marginBottom: "2rem" }}>
                <h3>Overlap map</h3>
                <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  Each circle represents one database. Circle size is proportional to
                  total records; overlapping areas reflect pairwise shared paper-group
                  counts. Click a circle to filter the paper groups below.
                </p>
                <EulerDiagram
                  visualData={visualData}
                  sourceTotals={data.sources}
                  selectedSourceId={selectedSourceId}
                  onSourceClick={setSelectedSourceId}
                />
              </section>
            )}

            {/* ── Pairwise overlap matrix (secondary) ──────────────────────── */}
            {visualData && visualData.sources.length >= 2 && (
              <section style={{ marginBottom: "2rem" }}>
                <h3>Pairwise overlap counts</h3>
                <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  Number of shared paper groups between every pair of sources.
                  Diagonal cells show unique record counts per source.
                  Click a cell to highlight matching groups below.
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
                  <p style={{ marginTop: "0.4rem", fontSize: "0.82rem", color: "#5f6368" }}>
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

            {/* ── Same paper groups ─────────────────────────────────────────── */}
            <section style={{ marginBottom: "2rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "1rem",
                  marginBottom: "0.5rem",
                }}
              >
                <h3 style={{ margin: 0 }}>Same paper groups</h3>
                <button
                  className="btn-secondary"
                  style={{ fontSize: "0.82rem", padding: "0.25rem 0.6rem" }}
                  onClick={() => setShowLinkForm((v) => !v)}
                >
                  {showLinkForm ? "Cancel" : "+ Link records (same paper)"}
                </button>
              </div>

              <p className="muted" style={{ marginBottom: "0.75rem", fontSize: "0.85rem" }}>
                Each row is a <strong>paper group</strong>: records from different databases
                that describe the same publication. Groups help you avoid screening the
                same paper twice. Click a row to expand and see the individual records.
              </p>

              {/* Manual link form */}
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
                    Enter comma-separated <strong>record_source IDs</strong> from
                    different databases that refer to the same paper.
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
                      {manualLink.isPending ? "Linking…" : "Link records"}
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
                    width: 1, height: 18,
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
                {hasActiveFilter && (
                  <button
                    onClick={() => {
                      setOriginFilter("all");
                      setShowPinnedOnly(false);
                      setMinSourcesFilter(0);
                      setSelectedSourceId(null);
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

              {/* Pagination — top */}
              {totalItems > 0 && <PaginationStrip {...paginationProps} />}

              {/* Table */}
              {allClusters.length === 0 && totalItems === 0 ? (
                <p className="muted">
                  {hasActiveFilter
                    ? "No paper groups match the current filters."
                    : "No paper groups yet. Run overlap detection to find shared records, or link records manually above."}
                </p>
              ) : (
                <table className="import-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 200 }}>Title</th>
                      <th>Sources</th>
                      <th>Records</th>
                      <th>Match evidence</th>
                      <th>Origin</th>
                      <th title="Pinned groups are preserved across re-runs">Pinned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allClusters.map((c) => (
                      <ClusterRow
                        key={c.cluster_id}
                        cluster={c}
                        expanded={expandedClusterId === c.cluster_id}
                        onToggleExpand={() =>
                          setExpandedClusterId((prev) =>
                            prev === c.cluster_id ? null : c.cluster_id
                          )
                        }
                        onToggleLock={(locked) =>
                          lockCluster.mutate({ clusterId: c.cluster_id, locked })
                        }
                        highlightedPair={highlightedPair}
                        selectedSourceId={selectedSourceId}
                        sourceColorMap={sourceColorMap}
                      />
                    ))}
                  </tbody>
                </table>
              )}

              {/* Pagination — bottom */}
              {totalItems > 0 && <PaginationStrip {...paginationProps} />}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClusterRow — expandable row for "Same paper groups" table
// ---------------------------------------------------------------------------

function ClusterRow({
  cluster,
  expanded,
  onToggleExpand,
  onToggleLock,
  highlightedPair,
  selectedSourceId,
  sourceColorMap,
}: {
  cluster: OverlapClusterDetail;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleLock: (locked: boolean) => void;
  highlightedPair: [string, string] | null;
  selectedSourceId: string | null;
  sourceColorMap: Record<string, string>;
}) {
  const canonical =
    cluster.members.find((m) => m.role === "canonical") ?? cluster.members[0];

  const title = canonical?.title ?? "(no title)";
  const year  = canonical?.year ?? null;

  const uniqueSources = cluster.members
    .map((m) => ({ id: m.source_id, name: m.source_name }))
    .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);

  const clusterSourceIds = uniqueSources.map((s) => s.id);

  const isHighlightedByPair =
    highlightedPair !== null &&
    clusterSourceIds.includes(highlightedPair[0]) &&
    clusterSourceIds.includes(highlightedPair[1]);

  const isHighlightedBySource =
    selectedSourceId !== null && clusterSourceIds.includes(selectedSourceId);

  const isHighlighted = isHighlightedByPair;

  return (
    <>
      <tr
        onClick={onToggleExpand}
        style={{
          cursor: "pointer",
          background: isHighlighted ? "#fce8e6" : isHighlightedBySource ? "#e8f0fe" : undefined,
          outline: isHighlighted ? "2px solid #ea4335" : undefined,
        }}
      >
        {/* Title + year */}
        <td style={{ maxWidth: 260 }}>
          <span
            title={title}
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.85rem",
              color: "#3c4043",
            }}
          >
            {title.length > 65 ? title.slice(0, 65) + "…" : title}
          </span>
          {year !== null && (
            <span style={{ fontSize: "0.75rem", color: "#80868b" }}>{year}</span>
          )}
        </td>

        {/* Source badges */}
        <td style={{ verticalAlign: "middle" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.2rem" }}>
            {uniqueSources.map((s) => (
              <SourceBadge key={s.id} name={s.name} color={sourceColorMap[s.id] ?? "#5f6368"} />
            ))}
          </div>
        </td>

        {/* Member count */}
        <td style={{ textAlign: "center" }}>{cluster.member_count}</td>

        {/* Match evidence */}
        <td style={{ fontSize: "0.78rem", color: "#5f6368", whiteSpace: "nowrap" }}>
          {evidenceLabel(cluster.match_tier)}
        </td>

        {/* Origin */}
        <td>
          <OriginBadge origin={cluster.origin} />
        </td>

        {/* Pin */}
        <td onClick={(e) => e.stopPropagation()}>
          <button
            title={
              cluster.locked
                ? "Pinned — preserved across re-runs. Click to unpin."
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
      </tr>

      {/* Expanded member rows */}
      {expanded &&
        cluster.members.map((m) => (
          <MemberRow key={m.record_source_id} member={m} sourceColorMap={sourceColorMap} />
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// MemberRow — one record inside an expanded ClusterRow
// ---------------------------------------------------------------------------

function MemberRow({
  member,
  sourceColorMap,
}: {
  member: OverlapClusterMemberDetail;
  sourceColorMap: Record<string, string>;
}) {
  const color = sourceColorMap[member.source_id] ?? "#5f6368";
  return (
    <tr style={{ background: "#fafafa" }}>
      <td
        colSpan={6}
        style={{ paddingLeft: "1.5rem", paddingTop: "0.3rem", paddingBottom: "0.3rem" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
          <SourceBadge name={member.source_name} color={color} />
          <span style={{ fontSize: "0.82rem", color: "#3c4043" }}>
            {member.title ?? <em style={{ color: "#aaa" }}>no title</em>}
          </span>
          {member.year !== null && (
            <span style={{ fontSize: "0.75rem", color: "#80868b" }}>{member.year}</span>
          )}
          {member.doi && (
            <span style={{ fontSize: "0.75rem", color: "#80868b", fontFamily: "monospace" }}>
              {member.doi}
            </span>
          )}
          {member.role === "canonical" && (
            <span
              style={{
                fontSize: "0.68rem",
                color: "#34a853",
                fontWeight: 600,
                border: "1px solid #b7dfc4",
                borderRadius: "0.2rem",
                padding: "0.05rem 0.25rem",
              }}
            >
              canonical
            </span>
          )}
          {member.added_by === "user" && member.note && (
            <span style={{ fontSize: "0.75rem", color: "#80868b", fontStyle: "italic" }}>
              "{member.note}"
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// SourceBadge — coloured chip for one source database
// ---------------------------------------------------------------------------

function SourceBadge({ name, color }: { name: string; color: string }) {
  const short = name.length > 9 ? name.slice(0, 9) + "…" : name;
  return (
    <span
      title={name}
      style={{
        display: "inline-block",
        fontSize: "0.7rem",
        fontWeight: 600,
        color,
        background: color + "18",
        border: `1px solid ${color}44`,
        borderRadius: "0.25rem",
        padding: "0.1rem 0.35rem",
        whiteSpace: "nowrap",
      }}
    >
      {short}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FilterChip
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
// PinIcon — thumbtack SVG (filled = pinned, outline = not pinned)
// ---------------------------------------------------------------------------

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {pinned ? (
        <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
      ) : (
        <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// OriginBadge
// ---------------------------------------------------------------------------

function OriginBadge({ origin }: { origin: string }) {
  const styles: Record<string, { color: string; bg: string; border: string; label: string }> = {
    auto:   { color: "#5f6368", bg: "#f1f3f4", border: "#dadce0", label: "Auto"   },
    manual: { color: "#1a73e8", bg: "#e8f0fe", border: "#c5d9f7", label: "Manual" },
    mixed:  { color: "#e37400", bg: "#fef7e0", border: "#f9ab00", label: "Mixed"  },
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
// SummaryCard
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
      <p style={{ fontSize: "2rem", fontWeight: 700, margin: "0 0 0.1rem" }}>{value}</p>
      <p style={{ fontSize: "0.8rem", color: "#5f6368", margin: 0 }}>{subtitle}</p>
      <p style={{ fontSize: "0.78rem", color: "#80868b", marginTop: "0.4rem", lineHeight: 1.4 }}>
        {description}
      </p>
    </div>
  );
}
