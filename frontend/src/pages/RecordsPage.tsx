import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { recordsApi, sourcesApi } from "../api/client";
import RecordsTable, { type ColumnVisibility, DEFAULT_COLUMNS } from "../components/RecordsTable";

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

// ── Small helpers ─────────────────────────────────────────────────────────────

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.3rem",
      background: "#e8f0fe",
      border: "1px solid #c5d9f5",
      borderRadius: "1rem",
      padding: "0.15rem 0.55rem 0.15rem 0.65rem",
      fontSize: "0.82rem",
      color: "#1a73e8",
    }}>
      {label}
      <button
        onClick={onRemove}
        style={{ background: "none", border: "none", cursor: "pointer",
                 fontSize: "0.9rem", lineHeight: 1, padding: 0, color: "#555" }}
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

  // ── URL-persisted state ──────────────────────────────────────────────────
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

  // ── UI-only state ────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState(q);
  const [showFilters, setShowFilters] = useState(false);

  // Sync search input → URL with debounce
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

  // ── Column visibility — localStorage per project ─────────────────────────
  const columnsKey = `${projectId}-columns`;
  const [columns, setColumns] = useState<ColumnVisibility>(() => {
    try {
      const stored = localStorage.getItem(columnsKey);
      return stored ? (JSON.parse(stored) as ColumnVisibility) : DEFAULT_COLUMNS;
    } catch {
      return DEFAULT_COLUMNS;
    }
  });

  function handleColumnsChange(c: ColumnVisibility) {
    setColumns(c);
    try { localStorage.setItem(columnsKey, JSON.stringify(c)); } catch { /* ignore */ }
  }

  // ── Data queries ─────────────────────────────────────────────────────────
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
        page,
        per_page: perPage,
        q: q || undefined,
        sort,
        source_ids: sourceIds.length > 0 ? sourceIds : undefined,
        year_min: yearMin,
        year_max: yearMax,
        ta_status: taStatus,
        ft_status: ftStatus,
        has_extraction: hasExtraction,
      }).then((r) => r.data),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });

  const yr = data?.year_range;

  // ── URL mutators ─────────────────────────────────────────────────────────
  const setSort = useCallback((s: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", s);
      next.set("page", "1");
      return next;
    });
  }, [setSearchParams]);

  const setPage = useCallback((p: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", String(p));
      return next;
    });
  }, [setSearchParams]);

  const setPerPage = useCallback((n: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("per_page", String(n));
      next.set("page", "1");
      return next;
    });
  }, [setSearchParams]);

  function toggleSourceId(id: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = prev.getAll("source_ids");
      next.delete("source_ids");
      if (current.includes(id)) {
        current.filter((x) => x !== id).forEach((x) => next.append("source_ids", x));
      } else {
        [...current, id].forEach((x) => next.append("source_ids", x));
      }
      next.set("page", "1");
      return next;
    });
  }

  function setYearMin(v: string) {
    setSearchParams((prev) => setParam(prev, "year_min", v || undefined));
  }
  function setYearMax(v: string) {
    setSearchParams((prev) => setParam(prev, "year_max", v || undefined));
  }
  function setTaStatus(v: string) {
    setSearchParams((prev) => setParam(prev, "ta_status", v || undefined));
  }
  function setFtStatus(v: string) {
    setSearchParams((prev) => setParam(prev, "ft_status", v || undefined));
  }
  function setHasExtraction(v: string) {
    setSearchParams((prev) => setParam(prev, "has_extraction", v || undefined));
  }

  function clearAllFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("source_ids");
      next.delete("year_min");
      next.delete("year_max");
      next.delete("ta_status");
      next.delete("ft_status");
      next.delete("has_extraction");
      next.set("page", "1");
      return next;
    });
  }

  // ── Active filter chips ──────────────────────────────────────────────────
  const chips: { label: string; onRemove: () => void }[] = [];

  if (sourceIds.length > 0) {
    sourceIds.forEach((sid) => {
      const name = sources?.find((s) => s.id === sid)?.name ?? sid;
      chips.push({
        label: `Source: ${name}`,
        onRemove: () => toggleSourceId(sid),
      });
    });
  }
  if (yearMin !== undefined || yearMax !== undefined) {
    const yearLabel =
      yearMin && yearMax ? `Year: ${yearMin}–${yearMax}` :
      yearMin ? `Year ≥ ${yearMin}` :
      `Year ≤ ${yearMax}`;
    chips.push({
      label: yearLabel,
      onRemove: () => {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("year_min");
          next.delete("year_max");
          return next;
        });
      },
    });
  }
  if (taStatus) {
    chips.push({
      label: `TA: ${taStatus}`,
      onRemove: () => setSearchParams((prev) => setParam(prev, "ta_status", undefined)),
    });
  }
  if (ftStatus) {
    chips.push({
      label: `FT: ${ftStatus}`,
      onRemove: () => setSearchParams((prev) => setParam(prev, "ft_status", undefined)),
    });
  }
  if (hasExtraction !== undefined) {
    chips.push({
      label: hasExtraction ? "Has extraction" : "No extraction",
      onRemove: () => setSearchParams((prev) => setParam(prev, "has_extraction", undefined)),
    });
  }

  const hasActiveFilters = chips.length > 0;

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
        <Link to={`/projects/${projectId}/import`} className="btn-primary">Import more</Link>
      </header>
      <main>
        {/* ── Toolbar ───────────────────────────────────────────────────── */}
        <div className="records-toolbar" style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap" }}>
          <input
            type="search"
            className="search-input"
            placeholder="Search by title or author…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ flex: "1 1 200px", minWidth: "160px" }}
          />

          {/* Sort */}
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", color: "#5f6368" }}>
            Sort:
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              style={{ fontSize: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.5rem" }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          {/* Page size */}
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem", color: "#5f6368" }}>
            Show:
            <select
              value={perPage}
              onChange={(e) => setPerPage(parseInt(e.target.value))}
              style={{ fontSize: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.5rem" }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>

          {/* Filters toggle */}
          <button
            className="btn-ghost"
            style={{ fontSize: "0.85rem", position: "relative" }}
            onClick={() => setShowFilters((v) => !v)}
          >
            Filters {hasActiveFilters ? `(${chips.length})` : ""} {showFilters ? "▴" : "▾"}
          </button>

          <span className="muted" style={{ marginLeft: "auto" }}>
            {isLoading ? "Loading…" : `${data?.total ?? 0} records`}
          </span>
        </div>

        {/* ── Filter panel ─────────────────────────────────────────────────── */}
        {showFilters && (
          <div style={{
            border: "1px solid #dadce0",
            borderRadius: "0.5rem",
            padding: "1rem",
            marginBottom: "0.75rem",
            background: "#fafafa",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "1rem",
          }}>
            {/* Sources */}
            {sources && sources.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                  Source
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  {sources.map((s) => (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(s.id)}
                        onChange={() => toggleSourceId(s.id)}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Year range */}
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                Year range{yr && (yr.min || yr.max) ? ` (${yr.min ?? "?"}–${yr.max ?? "?"})` : ""}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <input
                  type="number"
                  placeholder={yr?.min ? String(yr.min) : "From"}
                  value={yearMinRaw ?? ""}
                  onChange={(e) => setYearMin(e.target.value)}
                  style={{ width: "80px", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.4rem", fontSize: "0.85rem" }}
                />
                <span style={{ color: "#888" }}>–</span>
                <input
                  type="number"
                  placeholder={yr?.max ? String(yr.max) : "To"}
                  value={yearMaxRaw ?? ""}
                  onChange={(e) => setYearMax(e.target.value)}
                  style={{ width: "80px", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.4rem", fontSize: "0.85rem" }}
                />
              </div>
            </div>

            {/* TA Status */}
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                TA Status
              </div>
              <select
                value={taStatus ?? ""}
                onChange={(e) => setTaStatus(e.target.value)}
                style={{ width: "100%", fontSize: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.5rem" }}
              >
                <option value="">All</option>
                <option value="unscreened">Unscreened</option>
                <option value="included">Included</option>
                <option value="excluded">Excluded</option>
              </select>
            </div>

            {/* FT Status */}
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                Full-text Status
              </div>
              <select
                value={ftStatus ?? ""}
                onChange={(e) => setFtStatus(e.target.value)}
                style={{ width: "100%", fontSize: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.5rem" }}
              >
                <option value="">All</option>
                <option value="unscreened">Unreviewed</option>
                <option value="included">Included</option>
                <option value="excluded">Excluded</option>
              </select>
            </div>

            {/* Extraction */}
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.82rem", color: "#5f6368", marginBottom: "0.4rem" }}>
                Extraction
              </div>
              <select
                value={hasExtractRaw ?? ""}
                onChange={(e) => setHasExtraction(e.target.value)}
                style={{ width: "100%", fontSize: "0.85rem", border: "1px solid #dadce0", borderRadius: "0.375rem", padding: "0.25rem 0.5rem" }}
              >
                <option value="">All</option>
                <option value="true">Has extraction</option>
                <option value="false">No extraction</option>
              </select>
            </div>

            {/* Clear all */}
            {hasActiveFilters && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: "0.82rem", color: "#d93025" }}
                  onClick={clearAllFilters}
                >
                  Clear all filters
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Active filter chips ─────────────────────────────────────────── */}
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
            {chips.map((chip, i) => (
              <FilterChip key={i} label={chip.label} onRemove={chip.onRemove} />
            ))}
          </div>
        )}

        {/* ── Table ─────────────────────────────────────────────────────────── */}
        <RecordsTable
          records={data?.records ?? []}
          sort={sort}
          onSortChange={setSort}
          isLoading={isLoading}
          columns={columns}
          onColumnsChange={handleColumnsChange}
        />

        {/* ── Pagination ────────────────────────────────────────────────────── */}
        {data && data.total_pages > 1 && (
          <div className="pagination">
            <button onClick={() => setPage(page - 1)} disabled={page <= 1} className="btn-ghost">
              Previous
            </button>
            <span>Page {page} of {data.total_pages}</span>
            <button onClick={() => setPage(page + 1)} disabled={page >= data.total_pages} className="btn-ghost">
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
