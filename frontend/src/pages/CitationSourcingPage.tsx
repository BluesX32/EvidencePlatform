import React, { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { citationsApi } from "../api/client";
import type { CitationCandidate, CitationDirection, CandidateDecision } from "../api/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "#188038";
    case "running":   return "#f29900";
    case "failed":    return "#d93025";
    default:          return "#80868b";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "0.15rem 0.6rem",
      borderRadius: "1rem",
      background: statusColor(status) + "18",
      color: statusColor(status),
      fontSize: "0.78rem",
      fontWeight: 600,
      textTransform: "capitalize",
    }}>
      {status === "running" ? "⟳ Running…" : status}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: "backward" | "forward" }) {
  const isBack = direction === "backward";
  return (
    <span style={{
      display: "inline-block",
      padding: "0.12rem 0.5rem",
      borderRadius: "0.4rem",
      background: isBack ? "#e8f0fe" : "#fce8e6",
      color: isBack ? "#1a73e8" : "#c5221f",
      fontSize: "0.72rem",
      fontWeight: 600,
      whiteSpace: "nowrap",
    }}>
      {isBack ? "← Backward" : "→ Forward"}
    </span>
  );
}

function DecisionButton({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: "green" | "red" | "blue";
  onClick: () => void;
}) {
  const colors = {
    green: { bg: active ? "#e6f4ea" : "#f8f9fa", border: active ? "#34a853" : "#dadce0", text: active ? "#188038" : "#5f6368" },
    red:   { bg: active ? "#fce8e6" : "#f8f9fa", border: active ? "#ea4335" : "#dadce0", text: active ? "#c5221f" : "#5f6368" },
    blue:  { bg: active ? "#e8f0fe" : "#f8f9fa", border: active ? "#1a73e8" : "#dadce0", text: active ? "#1558d6" : "#5f6368" },
  }[color];
  return (
    <button
      onClick={onClick}
      style={{
        padding: "0.22rem 0.6rem",
        borderRadius: "0.4rem",
        border: `1.5px solid ${colors.border}`,
        background: colors.bg,
        color: colors.text,
        fontSize: "0.76rem",
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function formatAuthors(authors: string[] | null): string {
  if (!authors || authors.length === 0) return "";
  if (authors.length <= 3) return authors.join(", ");
  return authors.slice(0, 3).join(", ") + " et al.";
}

// ── CandidateRow ─────────────────────────────────────────────────────────────

function CandidateRow({
  c,
  projectId,
  searchId,
  onDecide,
}: {
  c: CitationCandidate;
  projectId: string;
  searchId: string;
  onDecide: (id: string, decision: CandidateDecision | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const decide = (d: CandidateDecision) => {
    // Toggle: clicking the active decision clears it
    onDecide(c.id, c.decision === d ? null : d);
  };

  return (
    <div
      style={{
        borderBottom: "1px solid #e8eaed",
        padding: "0.75rem 1rem",
        background: c.in_project ? "#f8f9fa" : "white",
      }}
    >
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
        {/* Direction badge */}
        <div style={{ paddingTop: "0.15rem", flexShrink: 0 }}>
          <DirectionBadge direction={c.direction} />
        </div>

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
            <span
              style={{
                fontWeight: 600,
                fontSize: "0.9rem",
                color: "#202124",
                cursor: c.abstract ? "pointer" : "default",
              }}
              onClick={() => c.abstract && setExpanded(e => !e)}
              title={c.abstract ? "Click to expand abstract" : undefined}
            >
              {c.title || "(no title)"}
            </span>
            {c.in_project && (
              <span style={{
                padding: "0.1rem 0.45rem",
                borderRadius: "0.4rem",
                background: "#e8f0fe",
                color: "#1a73e8",
                fontSize: "0.72rem",
                fontWeight: 600,
                flexShrink: 0,
              }}>
                Already in project
                {c.project_record_id && (
                  <Link
                    to={`/projects/${projectId}/records`}
                    style={{ marginLeft: "0.3rem", color: "#1a73e8" }}
                  >
                    ↗
                  </Link>
                )}
              </span>
            )}
          </div>

          <div style={{ fontSize: "0.8rem", color: "#5f6368", marginTop: "0.2rem" }}>
            {formatAuthors(c.authors)}
            {c.year && <span> · {c.year}</span>}
            {c.journal && <span> · <em>{c.journal}</em></span>}
            {c.doi && (
              <span>
                {" · "}
                <a
                  href={`https://doi.org/${c.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#1a73e8" }}
                >
                  {c.doi}
                </a>
              </span>
            )}
          </div>

          {expanded && c.abstract && (
            <div style={{
              marginTop: "0.5rem",
              fontSize: "0.82rem",
              color: "#3c4043",
              background: "#f8f9fa",
              borderRadius: "0.4rem",
              padding: "0.5rem 0.75rem",
              lineHeight: 1.55,
            }}>
              {c.abstract}
            </div>
          )}
        </div>

        {/* Decision buttons */}
        <div style={{ display: "flex", gap: "0.3rem", flexShrink: 0, paddingTop: "0.05rem" }}>
          <DecisionButton label="Include"  active={c.decision === "include"}         color="green" onClick={() => decide("include")} />
          <DecisionButton label="Exclude"  active={c.decision === "exclude"}         color="red"   onClick={() => decide("exclude")} />
          <DecisionButton label="Done"     active={c.decision === "already_screened"} color="blue"  onClick={() => decide("already_screened")} />
        </div>
      </div>
    </div>
  );
}

// ── Search history list ───────────────────────────────────────────────────────

function SearchHistoryView({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [direction, setDirection] = useState<CitationDirection>("both");
  const [starting, setStarting] = useState(false);

  const { data: searches = [], isLoading } = useQuery({
    queryKey: ["citation-searches", projectId],
    queryFn: () => citationsApi.listSearches(projectId).then(r => r.data),
  });

  const startMutation = useMutation({
    mutationFn: () => citationsApi.startSearch(projectId, direction),
    onSuccess: res => navigate(`/projects/${projectId}/citations/${res.data.id}`),
    onMutate: () => setStarting(true),
    onSettled: () => setStarting(false),
  });

  return (
    <div style={{ padding: "1.5rem", maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "#202124" }}>
            Citation Searches
          </h2>
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.84rem", color: "#5f6368" }}>
            Automatically find papers referenced by or citing your extracted studies.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <select
            value={direction}
            onChange={e => setDirection(e.target.value as CitationDirection)}
            style={{
              padding: "0.35rem 0.65rem",
              borderRadius: "0.4rem",
              border: "1px solid #dadce0",
              fontSize: "0.84rem",
              background: "white",
              color: "#202124",
            }}
          >
            <option value="both">Both directions</option>
            <option value="backward">Backward only (references)</option>
            <option value="forward">Forward only (citations)</option>
          </select>
          <button
            className="btn-primary"
            onClick={() => startMutation.mutate()}
            disabled={starting}
            style={{ fontSize: "0.84rem" }}
          >
            {starting ? "Starting…" : "New Citation Search"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p style={{ color: "#5f6368", fontSize: "0.875rem" }}>Loading…</p>
      ) : searches.length === 0 ? (
        <div style={{
          textAlign: "center",
          padding: "3rem",
          background: "#f8f9fa",
          borderRadius: "0.75rem",
          color: "#5f6368",
        }}>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No citation searches yet.</p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem" }}>
            Start one above to discover related papers via backward/forward citation sourcing.
          </p>
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e8eaed", color: "#5f6368", textAlign: "left" }}>
              <th style={{ padding: "0.5rem 0.75rem" }}>Date</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Direction</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Status</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Candidates</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Already in project</th>
              <th style={{ padding: "0.5rem 0.75rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {searches.map(s => (
              <tr key={s.id} style={{ borderBottom: "1px solid #e8eaed" }}>
                <td style={{ padding: "0.6rem 0.75rem", color: "#5f6368" }}>
                  {new Date(s.created_at).toLocaleDateString()}
                </td>
                <td style={{ padding: "0.6rem 0.75rem", textTransform: "capitalize" }}>{s.direction}</td>
                <td style={{ padding: "0.6rem 0.75rem" }}><StatusBadge status={s.status} /></td>
                <td style={{ padding: "0.6rem 0.75rem" }}>{s.candidate_count ?? "—"}</td>
                <td style={{ padding: "0.6rem 0.75rem" }}>{s.already_in_project_count ?? "—"}</td>
                <td style={{ padding: "0.6rem 0.75rem" }}>
                  <Link
                    to={`/projects/${projectId}/citations/${s.id}`}
                    style={{ color: "#1a73e8", fontWeight: 500 }}
                  >
                    Review →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Candidate screening view ──────────────────────────────────────────────────

function CandidateScreeningView({
  projectId,
  searchId,
}: {
  projectId: string;
  searchId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("both");
  const [importing, setImporting] = useState(false);

  const { data: search, isLoading: searchLoading } = useQuery({
    queryKey: ["citation-search", projectId, searchId],
    queryFn: () => citationsApi.getSearch(projectId, searchId).then(r => r.data),
    refetchInterval: data =>
      data?.status === "running" || data?.status === "pending" ? 3000 : false,
  });

  const { data: candidatesPage, isLoading: candidatesLoading } = useQuery({
    queryKey: ["citation-candidates", projectId, searchId, page, decisionFilter, directionFilter],
    queryFn: () =>
      citationsApi.listCandidates(projectId, searchId, {
        page,
        per_page: 25,
        decision: decisionFilter === "all" ? undefined : decisionFilter,
        direction: directionFilter === "both" ? undefined : directionFilter,
      }).then(r => r.data),
    enabled: !!search,
  });

  const decideMutation = useMutation({
    mutationFn: ({ candidateId, decision }: { candidateId: string; decision: CandidateDecision | null }) =>
      citationsApi.submitDecision(projectId, searchId, candidateId, { decision }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["citation-candidates", projectId, searchId] });
    },
  });

  const importMutation = useMutation({
    mutationFn: () => citationsApi.importIncluded(projectId, searchId),
    onSuccess: () => {
      setImporting(false);
      navigate(`/projects/${projectId}/import`);
    },
    onMutate: () => setImporting(true),
    onError: () => setImporting(false),
  });

  if (searchLoading) {
    return <div style={{ padding: "2rem", color: "#5f6368" }}>Loading…</div>;
  }
  if (!search) {
    return <div style={{ padding: "2rem", color: "#c5221f" }}>Search not found.</div>;
  }

  const DECISION_TABS = [
    { value: "all", label: "All" },
    { value: "unreviewed", label: "Unreviewed" },
    { value: "include", label: "Include" },
    { value: "exclude", label: "Exclude" },
    { value: "already_screened", label: "Done" },
  ];

  const DIRECTION_TABS = [
    { value: "both", label: "Both" },
    { value: "backward", label: "← Backward" },
    { value: "forward", label: "→ Forward" },
  ];

  const tabStyle = (active: boolean) => ({
    padding: "0.3rem 0.75rem",
    borderRadius: "0.4rem",
    border: `1.5px solid ${active ? "#1a73e8" : "#dadce0"}`,
    background: active ? "#e8f0fe" : "white",
    color: active ? "#1a73e8" : "#5f6368",
    fontSize: "0.8rem",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
  });

  const candidates = candidatesPage?.items ?? [];
  const total = candidatesPage?.total ?? 0;
  const totalPages = candidatesPage?.total_pages ?? 1;

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1000 }}>
      {/* Header */}
      <div style={{ marginBottom: "1rem" }}>
        <Link
          to={`/projects/${projectId}/citations`}
          style={{ fontSize: "0.82rem", color: "#5f6368", textDecoration: "none" }}
        >
          ← Citation Searches
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#202124" }}>
            Citation Search
          </h2>
          <StatusBadge status={search.status} />
          <span style={{ fontSize: "0.8rem", color: "#5f6368", textTransform: "capitalize" }}>
            {search.direction}
          </span>
        </div>
        {search.status === "completed" && (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.84rem", color: "#3c4043" }}>
            <strong>{search.candidate_count ?? 0}</strong> candidates found
            {search.already_in_project_count != null && search.already_in_project_count > 0 && (
              <> · <strong>{search.already_in_project_count}</strong> already in project</>
            )}
          </p>
        )}
        {search.status === "running" && (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.84rem", color: "#f29900" }}>
            Fetching citations from Semantic Scholar… This may take a few minutes.
          </p>
        )}
        {search.status === "failed" && search.error_msg && (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.84rem", color: "#c5221f" }}>
            Error: {search.error_msg}
          </p>
        )}
      </div>

      {/* Filters */}
      {search.status === "completed" && (
        <>
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            {DECISION_TABS.map(t => (
              <button
                key={t.value}
                style={tabStyle(decisionFilter === t.value)}
                onClick={() => { setDecisionFilter(t.value); setPage(1); }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            {DIRECTION_TABS.map(t => (
              <button
                key={t.value}
                style={tabStyle(directionFilter === t.value)}
                onClick={() => { setDirectionFilter(t.value); setPage(1); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Candidate list */}
      <div style={{ border: "1px solid #e8eaed", borderRadius: "0.5rem", overflow: "hidden", marginBottom: "1rem" }}>
        {candidatesLoading ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#5f6368" }}>Loading candidates…</div>
        ) : candidates.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#5f6368" }}>
            {search.status === "running" || search.status === "pending"
              ? "Candidates will appear here once the search completes."
              : "No candidates match the current filter."}
          </div>
        ) : (
          candidates.map(c => (
            <CandidateRow
              key={c.id}
              c={c}
              projectId={projectId}
              searchId={searchId}
              onDecide={(id, decision) => decideMutation.mutate({ candidateId: id, decision })}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", marginBottom: "1rem" }}>
          <button
            style={{ ...tabStyle(false), opacity: page <= 1 ? 0.4 : 1 }}
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            ← Prev
          </button>
          <span style={{ padding: "0.3rem 0.5rem", fontSize: "0.82rem", color: "#5f6368" }}>
            Page {page} of {totalPages} ({total} total)
          </span>
          <button
            style={{ ...tabStyle(false), opacity: page >= totalPages ? 0.4 : 1 }}
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            Next →
          </button>
        </div>
      )}

      {/* Import bar */}
      {search.status === "completed" && (
        <div style={{
          borderTop: "1px solid #e8eaed",
          paddingTop: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}>
          <p style={{ margin: 0, fontSize: "0.84rem", color: "#3c4043" }}>
            Papers marked <strong>Include</strong> will be imported into the project and enter the normal screening workflow.
          </p>
          <button
            className="btn-primary"
            disabled={importing}
            onClick={() => importMutation.mutate()}
            style={{ fontSize: "0.84rem", whiteSpace: "nowrap" }}
          >
            {importing ? "Importing…" : "Import Included Papers"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function CitationSourcingPage() {
  const { id: projectId, searchId } = useParams<{ id: string; searchId?: string }>();

  if (!projectId) return null;

  if (searchId) {
    return <CandidateScreeningView projectId={projectId} searchId={searchId} />;
  }
  return <SearchHistoryView projectId={projectId} />;
}
