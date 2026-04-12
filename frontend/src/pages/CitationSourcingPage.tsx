/**
 * CitationSourcingPage
 *
 * Two views:
 *  • History (/projects/:id/citations) — list of past searches, new-search form
 *  • Candidates (/projects/:id/citations/:searchId) — candidate browser with
 *    checkboxes, source-article filter, select-all, and import
 *
 * How citation sourcing works
 * ---------------------------
 * For each paper in your Extraction Library (TA+FT included AND extracted),
 * the platform looks up the paper on Semantic Scholar and fetches its complete
 * reference list (backward sourcing) and all papers that cite it (forward sourcing).
 * Results are cross-deduplicated so each unique paper appears once, checked
 * against records already in your project, and listed here for you to review.
 * Select the papers you want to add and click Import — they enter the normal
 * import pipeline (deduplication + overlap detection + screening) under a source
 * named after the original article that led to their discovery.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { citationsApi, extractionLibraryApi } from "../api/client";
import type {
  CitationCandidate,
  CitationDirection,
  CitationScope,
  CitationSourceArticle,
  ExtractionLibraryItem,
} from "../api/client";

// ── Shared helpers ────────────────────────────────────────────────────────────

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
      {isBack ? "← Refs" : "→ Citing"}
    </span>
  );
}

function formatAuthors(authors: string[] | null): string {
  if (!authors || authors.length === 0) return "";
  if (authors.length <= 3) return authors.join(", ");
  return authors.slice(0, 3).join(", ") + " et al.";
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "0.3rem 0.75rem",
    borderRadius: "0.4rem",
    border: `1.5px solid ${active ? "#1a73e8" : "#dadce0"}`,
    background: active ? "#e8f0fe" : "white",
    color: active ? "#1a73e8" : "#5f6368",
    fontSize: "0.8rem",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
  };
}

// ── CandidateRow ─────────────────────────────────────────────────────────────

function CandidateRow({
  c,
  projectId,
  selected,
  onToggle,
  onDelete,
}: {
  c: CitationCandidate;
  projectId: string;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      style={{
        borderBottom: "1px solid #e8eaed",
        padding: "0.65rem 1rem",
        background: selected ? "#f0f4ff" : c.in_project ? "#f8f9fa" : "white",
      }}
    >
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!!c.import_job_id}
          style={{ marginTop: "0.25rem", flexShrink: 0, cursor: c.import_job_id ? "default" : "pointer", accentColor: "#4f46e5" }}
          title={c.import_job_id ? "Already imported" : selected ? "Deselect" : "Select for import"}
        />

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
                fontSize: "0.88rem",
                color: "#202124",
                cursor: c.abstract ? "pointer" : "default",
              }}
              onClick={() => c.abstract && setExpanded(e => !e)}
              title={c.abstract ? "Click to expand abstract" : undefined}
            >
              {c.title || "(no title)"}
            </span>
            {c.import_job_id && (
              <span style={{ padding: "0.1rem 0.45rem", borderRadius: "0.4rem", background: "#e6f4ea", color: "#188038", fontSize: "0.72rem", fontWeight: 600, flexShrink: 0 }}>
                Imported
              </span>
            )}
            {c.in_project && !c.import_job_id && (
              <span style={{ padding: "0.1rem 0.45rem", borderRadius: "0.4rem", background: "#e8f0fe", color: "#1a73e8", fontSize: "0.72rem", fontWeight: 600, flexShrink: 0 }}>
                Already in project
                {c.project_record_id && (
                  <Link to={`/projects/${projectId}/records`} style={{ marginLeft: "0.3rem", color: "#1a73e8" }}>↗</Link>
                )}
              </span>
            )}
          </div>

          <div style={{ fontSize: "0.78rem", color: "#5f6368", marginTop: "0.15rem" }}>
            {formatAuthors(c.authors)}
            {c.year && <span> · {c.year}</span>}
            {c.journal && <span> · <em>{c.journal}</em></span>}
            {c.doi && (
              <span>
                {" · "}
                <a href={`https://doi.org/${c.doi}`} target="_blank" rel="noreferrer" style={{ color: "#1a73e8" }}>
                  {c.doi}
                </a>
              </span>
            )}
          </div>

          {expanded && c.abstract && (
            <div style={{
              marginTop: "0.4rem",
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

        {/* Delete */}
        <div style={{ flexShrink: 0, paddingTop: "0.05rem" }}>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: "0.3rem" }}>
              <button
                onClick={onDelete}
                style={{ padding: "0.18rem 0.5rem", borderRadius: "0.3rem", border: "1.5px solid #ea4335", background: "#fce8e6", color: "#c5221f", fontSize: "0.74rem", cursor: "pointer" }}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{ padding: "0.18rem 0.5rem", borderRadius: "0.3rem", border: "1.5px solid #dadce0", background: "white", color: "#5f6368", fontSize: "0.74rem", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Remove this candidate"
              style={{ padding: "0.18rem 0.45rem", borderRadius: "0.3rem", border: "1.5px solid #dadce0", background: "white", color: "#9aa0a6", fontSize: "0.74rem", cursor: "pointer" }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Search history view ───────────────────────────────────────────────────────

function SearchHistoryView({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<CitationDirection>("both");
  const [scope, setScope] = useState<CitationScope>("all");
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [showPaperPicker, setShowPaperPicker] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: searches = [], isLoading } = useQuery({
    queryKey: ["citation-searches", projectId],
    queryFn: () => citationsApi.listSearches(projectId).then(r => r.data),
  });

  // Extraction library for custom paper picker
  const { data: libItems = [] } = useQuery<ExtractionLibraryItem[]>({
    queryKey: ["extractions-library", projectId],
    queryFn: () => extractionLibraryApi.list(projectId).then(r => r.data),
    enabled: showPaperPicker,
  });

  const startMutation = useMutation({
    mutationFn: () => citationsApi.startSearch(
      projectId, direction, scope,
      scope === "custom" && customIds.length > 0 ? customIds : undefined,
    ),
    onSuccess: res => navigate(`/projects/${projectId}/citations/${res.data.id}`),
    onMutate: () => setStarting(true),
    onSettled: () => setStarting(false),
  });

  const deleteMutation = useMutation({
    mutationFn: (searchId: string) => citationsApi.deleteSearch(projectId, searchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["citation-searches", projectId] });
      setDeletingId(null);
    },
  });

  function toggleCustomId(id: string) {
    setCustomIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  const scopeLabel: Record<CitationScope, string> = {
    all: "All extracted papers",
    new: "New papers only (not used in prior searches)",
    custom: "Select specific papers…",
  };

  return (
    <div style={{ padding: "1.5rem", maxWidth: 960 }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ margin: "0 0 0.3rem", fontSize: "1.15rem", fontWeight: 700, color: "#202124" }}>
          Citation Searches
        </h2>
        <p style={{ margin: 0, fontSize: "0.84rem", color: "#5f6368", lineHeight: 1.5 }}>
          For each paper in your Extraction Library, the platform looks up its reference list
          (backward sourcing) and papers that cite it (forward sourcing) via Semantic Scholar.
          Results are deduplicated across all source papers, checked against records already
          in your project, and listed for you to select and import.
        </p>
      </div>

      {/* ── New search form ────────────────────────────────────────────── */}
      <div style={{ border: "1px solid #dadce0", borderRadius: "0.6rem", padding: "1rem 1.25rem", marginBottom: "1.5rem", background: "#fafafa" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#202124", marginBottom: "0.75rem" }}>
          New Citation Search
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>

          {/* Direction */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "#5f6368", marginBottom: "0.25rem", fontWeight: 500 }}>Direction</div>
            <select
              value={direction}
              onChange={e => setDirection(e.target.value as CitationDirection)}
              style={{ padding: "0.35rem 0.65rem", borderRadius: "0.4rem", border: "1px solid #dadce0", fontSize: "0.84rem", background: "white" }}
            >
              <option value="both">Both (references + citing)</option>
              <option value="backward">Backward — references only</option>
              <option value="forward">Forward — citing papers only</option>
            </select>
          </div>

          {/* Scope */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "#5f6368", marginBottom: "0.25rem", fontWeight: 500 }}>Source papers</div>
            <select
              value={scope}
              onChange={e => {
                setScope(e.target.value as CitationScope);
                if (e.target.value === "custom") setShowPaperPicker(true);
                else setShowPaperPicker(false);
              }}
              style={{ padding: "0.35rem 0.65rem", borderRadius: "0.4rem", border: "1px solid #dadce0", fontSize: "0.84rem", background: "white" }}
            >
              <option value="all">All extracted papers</option>
              <option value="new">New papers only (since last search)</option>
              <option value="custom">Select specific papers…</option>
            </select>
          </div>

          <button
            className="btn-primary"
            onClick={() => startMutation.mutate()}
            disabled={starting || (scope === "custom" && customIds.length === 0)}
            style={{ fontSize: "0.84rem", whiteSpace: "nowrap" }}
          >
            {starting ? "Starting…" : "Run Search"}
          </button>
        </div>

        {/* Custom paper picker */}
        {scope === "custom" && (
          <div style={{ marginTop: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.4rem", overflow: "hidden", maxHeight: 220, overflowY: "auto" }}>
            {libItems.length === 0 ? (
              <div style={{ padding: "1rem", color: "#5f6368", fontSize: "0.84rem" }}>
                No extracted papers available.
              </div>
            ) : (
              <>
                <div style={{ padding: "0.4rem 0.75rem", background: "#f1f3f4", borderBottom: "1px solid #dadce0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#5f6368" }}>
                    {customIds.length} of {libItems.length} selected
                  </span>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      onClick={() => setCustomIds(libItems.map(i => i.record_id ?? i.cluster_id ?? i.id))}
                      style={{ fontSize: "0.75rem", border: "none", background: "none", cursor: "pointer", color: "#1a73e8", fontWeight: 500 }}
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setCustomIds([])}
                      style={{ fontSize: "0.75rem", border: "none", background: "none", cursor: "pointer", color: "#c5221f", fontWeight: 500 }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                {libItems.map(item => {
                  const itemId = item.record_id ?? item.cluster_id ?? item.id;
                  const checked = customIds.includes(itemId);
                  return (
                    <label
                      key={item.id}
                      style={{
                        display: "flex", gap: "0.6rem", alignItems: "center",
                        padding: "0.4rem 0.75rem",
                        borderBottom: "1px solid #f0f0f0",
                        cursor: "pointer",
                        background: checked ? "#f0f4ff" : "white",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCustomId(itemId)}
                        style={{ accentColor: "#4f46e5" }}
                      />
                      <span style={{ fontSize: "0.82rem", color: "#202124" }}>
                        {item.title ?? <em style={{ color: "#888" }}>Untitled</em>}
                        {item.year && <span style={{ color: "#5f6368" }}> ({item.year})</span>}
                      </span>
                    </label>
                  );
                })}
              </>
            )}
          </div>
        )}

        {scope === "new" && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#5f6368" }}>
            Only extracted papers that were not used as source in any previous completed search will be included.
            Use this after importing a second cohort to avoid re-processing papers already sourced.
          </p>
        )}
      </div>

      {/* ── History table ────────────────────────────────────────────────── */}
      {isLoading ? (
        <p style={{ color: "#5f6368", fontSize: "0.875rem" }}>Loading…</p>
      ) : searches.length === 0 ? (
        <div style={{ textAlign: "center", padding: "2.5rem", background: "#f8f9fa", borderRadius: "0.75rem", color: "#5f6368" }}>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No citation searches yet.</p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem" }}>
            Run your first search above to start discovering related papers.
          </p>
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e8eaed", color: "#5f6368", textAlign: "left" }}>
              <th style={{ padding: "0.5rem 0.75rem" }}>Date &amp; time</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Direction</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Source papers</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Status</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Candidates</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>In project</th>
              <th style={{ padding: "0.5rem 0.75rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {searches.map(s => (
              <tr key={s.id} style={{ borderBottom: "1px solid #e8eaed" }}>
                <td style={{ padding: "0.6rem 0.75rem", color: "#5f6368", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                  {formatDateTime(s.created_at)}
                </td>
                <td style={{ padding: "0.6rem 0.75rem", textTransform: "capitalize" }}>{s.direction}</td>
                <td style={{ padding: "0.6rem 0.75rem", color: "#5f6368" }}>
                  {s.source_record_count != null ? s.source_record_count : "—"}
                  {s.scope === "new" && <span style={{ marginLeft: "0.3rem", fontSize: "0.72rem", color: "#8f9198" }}>(new)</span>}
                  {s.scope === "custom" && <span style={{ marginLeft: "0.3rem", fontSize: "0.72rem", color: "#8f9198" }}>(custom)</span>}
                </td>
                <td style={{ padding: "0.6rem 0.75rem" }}><StatusBadge status={s.status} /></td>
                <td style={{ padding: "0.6rem 0.75rem" }}>{s.candidate_count ?? "—"}</td>
                <td style={{ padding: "0.6rem 0.75rem" }}>{s.already_in_project_count ?? "—"}</td>
                <td style={{ padding: "0.6rem 0.75rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <Link
                      to={`/projects/${projectId}/citations/${s.id}`}
                      style={{ color: "#1a73e8", fontWeight: 500, whiteSpace: "nowrap" }}
                    >
                      Review →
                    </Link>
                    {deletingId === s.id ? (
                      <>
                        <button
                          onClick={() => deleteMutation.mutate(s.id)}
                          style={{ fontSize: "0.74rem", padding: "0.15rem 0.45rem", borderRadius: "0.3rem", border: "1.5px solid #ea4335", background: "#fce8e6", color: "#c5221f", cursor: "pointer" }}
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          style={{ fontSize: "0.74rem", padding: "0.15rem 0.45rem", borderRadius: "0.3rem", border: "1.5px solid #dadce0", background: "white", color: "#5f6368", cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setDeletingId(s.id)}
                        title="Delete this search and all its candidates"
                        style={{ fontSize: "0.74rem", padding: "0.15rem 0.45rem", borderRadius: "0.3rem", border: "1.5px solid #dadce0", background: "white", color: "#9aa0a6", cursor: "pointer" }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
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
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Local set of selected candidate IDs (mirrors server decision='include')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [initialised, setInitialised] = useState(false);

  // ── Data queries ────────────────────────────────────────────────────────
  const { data: search, isLoading: searchLoading } = useQuery({
    queryKey: ["citation-search", projectId, searchId],
    queryFn: () => citationsApi.getSearch(projectId, searchId).then(r => r.data),
    refetchInterval: (query: any) => {
      const d = query?.state?.data as { status?: string } | undefined;
      return d?.status === "running" || d?.status === "pending" ? 3000 : false;
    },
  });

  const { data: candidatesPage, isLoading: candidatesLoading } = useQuery({
    queryKey: ["citation-candidates", projectId, searchId, page, decisionFilter, directionFilter, sourceFilter],
    queryFn: () =>
      citationsApi.listCandidates(projectId, searchId, {
        page,
        per_page: 25,
        decision: decisionFilter === "all" ? undefined : decisionFilter,
        direction: directionFilter === "both" ? undefined : directionFilter,
        source_record_id: sourceFilter ?? undefined,
      }).then(r => r.data),
    enabled: !!search,
  });

  const { data: sourceArticles = [] } = useQuery<CitationSourceArticle[]>({
    queryKey: ["citation-sources", projectId, searchId],
    queryFn: () => citationsApi.listSourceArticles(projectId, searchId).then(r => r.data),
    enabled: search?.status === "completed",
  });

  // Seed selectedIds from server state on first load
  useEffect(() => {
    if (!initialised && candidatesPage) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const c of candidatesPage.items) {
          if (c.decision === "include") next.add(c.id);
        }
        return next;
      });
      setInitialised(true);
    }
  }, [candidatesPage, initialised]);

  // Also sync when page changes
  useEffect(() => {
    if (candidatesPage) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const c of candidatesPage.items) {
          if (c.decision === "include") next.add(c.id);
          // If we see a candidate that was previously selected but now decision=null on server,
          // trust the local state (user may have toggled while offline). We only ADD from server.
        }
        return next;
      });
    }
  }, [candidatesPage]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const decideMutation = useMutation({
    mutationFn: ({ candidateId, decision }: { candidateId: string; decision: "include" | null }) =>
      citationsApi.submitDecision(projectId, searchId, candidateId, { decision }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["citation-candidates", projectId, searchId] });
    },
  });

  const deleteCandidateMutation = useMutation({
    mutationFn: (candidateId: string) =>
      citationsApi.deleteCandidate(projectId, searchId, candidateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["citation-candidates", projectId, searchId] });
    },
  });

  const importMutation = useMutation({
    mutationFn: () => citationsApi.importSelected(projectId, searchId),
    onSuccess: () => {
      setImporting(false);
      navigate(`/projects/${projectId}/import`);
    },
    onMutate: () => setImporting(true),
    onError: () => setImporting(false),
  });

  // ── Toggle helpers ──────────────────────────────────────────────────────
  function toggleCandidate(c: CitationCandidate) {
    const newSelected = !selectedIds.has(c.id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (newSelected) next.add(c.id); else next.delete(c.id);
      return next;
    });
    decideMutation.mutate({ candidateId: c.id, decision: newSelected ? "include" : null });
  }

  function selectAll() {
    const candidates = candidatesPage?.items ?? [];
    const allIds = candidates.filter(c => !c.import_job_id).map(c => c.id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      allIds.forEach(id => next.add(id));
      return next;
    });
    // Fire decisions in background
    for (const c of candidates) {
      if (!c.import_job_id && !selectedIds.has(c.id)) {
        decideMutation.mutate({ candidateId: c.id, decision: "include" });
      }
    }
  }

  function deselectAll() {
    const candidates = candidatesPage?.items ?? [];
    const pageIds = candidates.map(c => c.id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      pageIds.forEach(id => next.delete(id));
      return next;
    });
    for (const c of candidates) {
      if (selectedIds.has(c.id)) {
        decideMutation.mutate({ candidateId: c.id, decision: null });
      }
    }
  }

  // ── Early returns ────────────────────────────────────────────────────────
  if (searchLoading) {
    return <div style={{ padding: "2rem", color: "#5f6368" }}>Loading…</div>;
  }
  if (!search) {
    return <div style={{ padding: "2rem", color: "#c5221f" }}>Search not found.</div>;
  }

  const candidates = candidatesPage?.items ?? [];
  const total = candidatesPage?.total ?? 0;
  const totalPages = candidatesPage?.total_pages ?? 1;

  const DIRECTION_TABS = [
    { value: "both", label: "Both" },
    { value: "backward", label: "← Backward" },
    { value: "forward", label: "→ Forward" },
  ];

  const DECISION_TABS = [
    { value: "all", label: "All" },
    { value: "unselected", label: "Unselected" },
    { value: "include", label: "Selected" },
  ];

  const pageSelectedCount = candidates.filter(c => selectedIds.has(c.id)).length;
  const pageImportableCount = candidates.filter(c => !c.import_job_id).length;

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1060 }}>
      {/* Header */}
      <div style={{ marginBottom: "1rem" }}>
        <Link
          to={`/projects/${projectId}/citations`}
          style={{ fontSize: "0.82rem", color: "#5f6368", textDecoration: "none" }}
        >
          ← Citation Searches
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#202124" }}>
            Citation Search
          </h2>
          <StatusBadge status={search.status} />
          <span style={{ fontSize: "0.8rem", color: "#5f6368", textTransform: "capitalize" }}>
            {search.direction}
          </span>
          <span style={{ fontSize: "0.8rem", color: "#9aa0a6" }}>
            {formatDateTime(search.created_at)}
          </span>
        </div>

        {search.status === "completed" && (
          <div style={{ marginTop: "0.4rem", fontSize: "0.84rem", color: "#3c4043" }}>
            <strong>{search.candidate_count ?? 0}</strong> candidates found from{" "}
            <strong>{search.source_record_count ?? "?"}</strong> extracted papers
            {search.already_in_project_count != null && search.already_in_project_count > 0 && (
              <> · <strong>{search.already_in_project_count}</strong> already in project</>
            )}
            {search.scope === "new" && <span style={{ color: "#8f9198" }}> · new papers only</span>}
            {search.scope === "custom" && <span style={{ color: "#8f9198" }}> · custom selection</span>}
          </div>
        )}
        {search.status === "running" && (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.84rem", color: "#f29900" }}>
            Fetching citations from Semantic Scholar… This may take several minutes depending on the number of source papers.
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
          {/* Source article filter */}
          {sourceArticles.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.75rem", color: "#5f6368", marginBottom: "0.25rem", fontWeight: 500 }}>
                Filter by source paper:
              </div>
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                <button
                  style={tabStyle(sourceFilter === null)}
                  onClick={() => { setSourceFilter(null); setPage(1); }}
                >
                  All papers
                </button>
                {sourceArticles.map(sa => (
                  <button
                    key={sa.record_id}
                    style={tabStyle(sourceFilter === sa.record_id)}
                    onClick={() => { setSourceFilter(sa.record_id); setPage(1); }}
                    title={sa.title ?? undefined}
                  >
                    {sa.title ? sa.title.slice(0, 35) + (sa.title.length > 35 ? "…" : "") : "Untitled"}
                    {sa.year && <span style={{ color: "#8f9198", marginLeft: "0.25rem" }}>({sa.year})</span>}
                    <span style={{ marginLeft: "0.3rem", fontSize: "0.7rem", opacity: 0.7 }}>{sa.candidate_count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Direction + decision tabs */}
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
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
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
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

          {/* Select-all row */}
          {candidates.length > 0 && (
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.5rem", fontSize: "0.82rem" }}>
              <span style={{ color: "#5f6368" }}>
                {pageSelectedCount} of {pageImportableCount} on this page selected
              </span>
              <button
                onClick={selectAll}
                style={{ border: "none", background: "none", color: "#4f46e5", cursor: "pointer", fontWeight: 600, fontSize: "0.82rem", padding: 0 }}
              >
                Select all on page
              </button>
              <button
                onClick={deselectAll}
                style={{ border: "none", background: "none", color: "#c5221f", cursor: "pointer", fontWeight: 500, fontSize: "0.82rem", padding: 0 }}
              >
                Deselect all
              </button>
            </div>
          )}
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
              : "No candidates match the current filters."}
          </div>
        ) : (
          candidates.map(c => (
            <CandidateRow
              key={c.id}
              c={c}
              projectId={projectId}
              selected={selectedIds.has(c.id)}
              onToggle={() => toggleCandidate(c)}
              onDelete={() => deleteCandidateMutation.mutate(c.id)}
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
          flexWrap: "wrap",
        }}>
          <p style={{ margin: 0, fontSize: "0.84rem", color: "#3c4043", flex: 1 }}>
            Selected papers are imported under source names derived from the original article
            (e.g. <em>← Refs: Smith 2020</em>) — visible in the Extraction Library's Sources column.
            Imported papers enter the full screening workflow.
          </p>
          <button
            className="btn-primary"
            disabled={importing}
            onClick={() => importMutation.mutate()}
            style={{ fontSize: "0.84rem", whiteSpace: "nowrap" }}
          >
            {importing ? "Importing…" : "Import Selected Papers"}
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
