import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { recordsApi, sourcesApi } from "../api/client";
import RecordsTable, { type ColumnVisibility, DEFAULT_COLUMNS } from "../components/RecordsTable";
import EmptyState from "../components/EmptyState";

// ── URL helpers ──────────────────────────────────────────────────────────────

function setParam(prev: URLSearchParams, key: string, value: string | undefined): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value) next.set(key, value); else next.delete(key);
  return next;
}

// ── Sort options ─────────────────────────────────────────────────────────────

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "year_desc",    label: "Year (newest)" },
  { value: "year_asc",     label: "Year (oldest)" },
  { value: "title_asc",    label: "Title (A→Z)" },
  { value: "title_desc",   label: "Title (Z→A)" },
  { value: "author_asc",   label: "Author (A→Z)" },
  { value: "author_desc",  label: "Author (Z→A)" },
  { value: "journal_asc",  label: "Journal (A→Z)" },
  { value: "journal_desc", label: "Journal (Z→A)" },
  { value: "created_desc", label: "Imported (newest)" },
  { value: "created_asc",  label: "Imported (oldest)" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="badge badge-brand" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
      <span className="truncate" style={{ maxWidth: 200 }}>{label}</span>
      <button
        onClick={onRemove}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "0.85rem",
                 lineHeight: 1, padding: "0 0 0 2px", color: "var(--brand)", display: "flex" }}
        title="Remove filter"
      >
        ✕
      </button>
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecordsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const page       = parseInt(searchParams.get("page") ?? "1");
  const perPage    = parseInt(searchParams.get("per_page") ?? "50");
  const sort       = searchParams.get("sort") ?? "year_desc";
  const q          = searchParams.get("q") ?? "";
  const sourceIds  = searchParams.getAll("source_ids");
  const yearMinRaw = searchParams.get("year_min");
  const yearMaxRaw = searchParams.get("year_max");
  const yearMin    = yearMinRaw ? parseInt(yearMinRaw) : undefined;
  const yearMax    = yearMaxRaw ? parseInt(yearMaxRaw) : undefined;
  const taStatus   = searchParams.get("ta_status") ?? undefined;
  const ftStatus   = searchParams.get("ft_status") ?? undefined;
  const hasExtractRaw = searchParams.get("has_extraction");
  const hasExtraction = hasExtractRaw === "true" ? true : hasExtractRaw === "false" ? false : undefined;

  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(q);
  const [showFilters, setShowFilters] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (recordId: string) => recordsApi.delete(projectId!, recordId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["records", projectId] }),
  });

  useEffect(() => {
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (searchInput) next.set("q", searchInput); else next.delete("q");
        next.set("page", "1");
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const columnsKey = `${projectId}-columns`;
  const [columns, setColumns] = useState<ColumnVisibility>(() => {
    try {
      const stored = localStorage.getItem(columnsKey);
      return stored ? (JSON.parse(stored) as ColumnVisibility) : DEFAULT_COLUMNS;
    } catch { return DEFAULT_COLUMNS; }
  });
  function handleColumnsChange(c: ColumnVisibility) {
    setColumns(c);
    try { localStorage.setItem(columnsKey, JSON.stringify(c)); } catch { /* ignore */ }
  }

  const { data: sources } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => sourcesApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["records", projectId, page, perPage, sort, q, sourceIds, yearMin, yearMax,
               taStatus, ftStatus, hasExtractRaw],
    queryFn: () =>
      recordsApi.list(projectId!, {
        page, per_page: perPage, q: q || undefined, sort,
        source_ids: sourceIds.length > 0 ? sourceIds : undefined,
        year_min: yearMin, year_max: yearMax,
        ta_status: taStatus, ft_status: ftStatus, has_extraction: hasExtraction,
      }).then((r) => r.data),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });

  const yr = data?.year_range;

  const setSort = useCallback((s: string) => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set("sort", s); n.set("page", "1"); return n; });
  }, [setSearchParams]);
  const setPage = useCallback((p: number) => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set("page", String(p)); return n; });
  }, [setSearchParams]);
  const setPerPage = useCallback((n: number) => {
    setSearchParams(prev => { const nx = new URLSearchParams(prev); nx.set("per_page", String(n)); nx.set("page", "1"); return nx; });
  }, [setSearchParams]);

  function toggleSourceId(id: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = prev.getAll("source_ids");
      next.delete("source_ids");
      (current.includes(id) ? current.filter(x => x !== id) : [...current, id]).forEach(x => next.append("source_ids", x));
      next.set("page", "1");
      return next;
    });
  }

  function clearAllFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      ["source_ids", "year_min", "year_max", "ta_status", "ft_status", "has_extraction"].forEach(k => next.delete(k));
      next.set("page", "1");
      return next;
    });
  }

  const chips: { label: string; onRemove: () => void }[] = [];
  sourceIds.forEach(sid => {
    chips.push({ label: `Source: ${sources?.find(s => s.id === sid)?.name ?? sid}`, onRemove: () => toggleSourceId(sid) });
  });
  if (yearMin !== undefined || yearMax !== undefined) {
    chips.push({
      label: yearMin && yearMax ? `Year: ${yearMin}–${yearMax}` : yearMin ? `Year ≥ ${yearMin}` : `Year ≤ ${yearMax}`,
      onRemove: () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete("year_min"); n.delete("year_max"); return n; }),
    });
  }
  if (taStatus) chips.push({ label: `TA: ${taStatus}`, onRemove: () => setSearchParams(p => setParam(p, "ta_status", undefined)) });
  if (ftStatus) chips.push({ label: `FT: ${ftStatus}`, onRemove: () => setSearchParams(p => setParam(p, "ft_status", undefined)) });
  if (hasExtraction !== undefined) chips.push({ label: hasExtraction ? "Has extraction" : "No extraction", onRemove: () => setSearchParams(p => setParam(p, "has_extraction", undefined)) });

  const hasActiveFilters = chips.length > 0 || !!q;

  const labelStyle: React.CSSProperties = { fontSize: "0.82rem", fontWeight: 600, color: "var(--text-secondary)" };

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1>Records</h1>
          <span className="subtitle">{isLoading ? "Loading…" : `${data?.total ?? 0} records`}</span>
        </div>
        <Link to={`/projects/${projectId}/import`} className="btn-primary">Import more</Link>
      </header>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Search by title or author…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 160 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", ...labelStyle }}>
          Sort:
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ fontSize: "0.85rem" }}>
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", ...labelStyle }}>
          Show:
          <select value={perPage} onChange={e => setPerPage(parseInt(e.target.value))} style={{ fontSize: "0.85rem" }}>
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn-ghost btn-sm" onClick={() => setShowFilters(v => !v)}>
          Filters{hasActiveFilters ? ` (${chips.length})` : ""} {showFilters ? "▴" : "▾"}
        </button>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────────────────── */}
      {showFilters && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
          padding: "1rem", marginBottom: "0.75rem", background: "var(--surface-2)",
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1rem",
        }}>
          {sources && sources.length > 0 && (
            <div>
              <div style={labelStyle} className="section-title">Source</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.4rem" }}>
                {sources.map(s => (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={sourceIds.includes(s.id)} onChange={() => toggleSourceId(s.id)} />
                    <span className="truncate">{s.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={labelStyle} className="section-title">
              Year{yr && (yr.min || yr.max) ? ` (${yr.min ?? "?"}–${yr.max ?? "?"})` : ""}
            </div>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.4rem" }}>
              <input type="number" placeholder={yr?.min ? String(yr.min) : "From"}
                value={yearMinRaw ?? ""} onChange={e => setSearchParams(p => setParam(p, "year_min", e.target.value || undefined))}
                style={{ width: 76, fontSize: "0.85rem" }} />
              <span style={{ color: "var(--text-muted)" }}>–</span>
              <input type="number" placeholder={yr?.max ? String(yr.max) : "To"}
                value={yearMaxRaw ?? ""} onChange={e => setSearchParams(p => setParam(p, "year_max", e.target.value || undefined))}
                style={{ width: 76, fontSize: "0.85rem" }} />
            </div>
          </div>
          <div>
            <div style={labelStyle} className="section-title">TA Status</div>
            <select value={taStatus ?? ""} onChange={e => setSearchParams(p => setParam(p, "ta_status", e.target.value || undefined))}
              style={{ width: "100%", marginTop: "0.4rem", fontSize: "0.85rem" }}>
              <option value="">All</option>
              <option value="unscreened">Unscreened</option>
              <option value="included">Included</option>
              <option value="excluded">Excluded</option>
            </select>
          </div>
          <div>
            <div style={labelStyle} className="section-title">Full-text Status</div>
            <select value={ftStatus ?? ""} onChange={e => setSearchParams(p => setParam(p, "ft_status", e.target.value || undefined))}
              style={{ width: "100%", marginTop: "0.4rem", fontSize: "0.85rem" }}>
              <option value="">All</option>
              <option value="unscreened">Unreviewed</option>
              <option value="included">Included</option>
              <option value="excluded">Excluded</option>
            </select>
          </div>
          <div>
            <div style={labelStyle} className="section-title">Extraction</div>
            <select value={hasExtractRaw ?? ""} onChange={e => setSearchParams(p => setParam(p, "has_extraction", e.target.value || undefined))}
              style={{ width: "100%", marginTop: "0.4rem", fontSize: "0.85rem" }}>
              <option value="">All</option>
              <option value="true">Has extraction</option>
              <option value="false">No extraction</option>
            </select>
          </div>
          {hasActiveFilters && (
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button className="btn-danger btn-sm" onClick={clearAllFilters}>Clear all filters</button>
            </div>
          )}
        </div>
      )}

      {/* ── Active filter chips ──────────────────────────────────────────────── */}
      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
          {chips.map((chip, i) => <FilterChip key={i} label={chip.label} onRemove={chip.onRemove} />)}
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <RecordsTable
        records={data?.records ?? []}
        sort={sort}
        onSortChange={setSort}
        isLoading={isLoading}
        columns={columns}
        onColumnsChange={handleColumnsChange}
        onDelete={id => deleteMutation.mutate(id)}
        emptyState={hasActiveFilters ? undefined : (
          <EmptyState
            icon={<BookOpen size={36} />}
            title="No records yet"
            hint="Import citations from RIS/BibTeX files, or run a PubMed search to start building your corpus."
            action={
              <Link to={`/projects/${projectId}/import`} className="btn-primary btn-sm">
                Import records
              </Link>
            }
          />
        )}
      />

      {/* ── Pagination ──────────────────────────────────────────────────────── */}
      {data && data.total_pages > 1 && (
        <div className="pagination">
          <button onClick={() => setPage(page - 1)} disabled={page <= 1} className="btn-ghost btn-sm">Previous</button>
          <span>Page {page} of {data.total_pages}</span>
          <button onClick={() => setPage(page + 1)} disabled={page >= data.total_pages} className="btn-ghost btn-sm">Next</button>
        </div>
      )}
    </div>
  );
}
