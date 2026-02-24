import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { recordsApi, sourcesApi } from "../api/client";
import RecordsTable, { type ColumnVisibility, DEFAULT_COLUMNS } from "../components/RecordsTable";

export default function RecordsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseInt(searchParams.get("page") ?? "1");
  const sort = searchParams.get("sort") ?? "year_desc";
  const q = searchParams.get("q") ?? "";
  const sourceId = searchParams.get("source_id") ?? undefined;

  // Column visibility — persisted to localStorage keyed by project
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

  // Debounced search state
  const [searchInput, setSearchInput] = useState(q);
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

  const { data: sources } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => sourcesApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId && !!sourceId,
  });

  const activeSourceName = sourceId
    ? sources?.find((s) => s.id === sourceId)?.name
    : undefined;

  const { data, isLoading } = useQuery({
    queryKey: ["records", projectId, page, sort, q, sourceId],
    queryFn: () =>
      recordsApi
        .list(projectId!, { page, per_page: 50, q: q || undefined, sort, source_id: sourceId })
        .then((r) => r.data),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });

  function setSort(s: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", s);
      next.set("page", "1");
      return next;
    });
  }

  function setPage(p: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", String(p));
      return next;
    });
  }

  function clearSourceFilter() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("source_id");
      next.set("page", "1");
      return next;
    });
  }

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
        <Link to={`/projects/${projectId}/import`} className="btn-primary">Import more</Link>
      </header>
      <main>
        <div className="records-toolbar">
          <input
            type="search"
            className="search-input"
            placeholder="Search by title or author…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <span className="muted">
            {isLoading ? "Loading…" : `${data?.total ?? 0} records`}
          </span>
        </div>

        {sourceId && (
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            background: "#e8f0fe",
            border: "1px solid #c5d9f5",
            borderRadius: "1rem",
            padding: "0.2rem 0.6rem 0.2rem 0.75rem",
            fontSize: "0.85rem",
            marginBottom: "0.75rem",
          }}>
            <span>Filtered by: <strong>{activeSourceName ?? "source"}</strong></span>
            <button
              onClick={clearSourceFilter}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "1rem",
                lineHeight: 1,
                padding: "0 0.1rem",
                color: "#555",
              }}
              title="Clear filter"
            >
              ✕
            </button>
          </div>
        )}

        <RecordsTable
          records={data?.records ?? []}
          sort={sort}
          onSortChange={setSort}
          isLoading={isLoading}
          columns={columns}
          onColumnsChange={handleColumnsChange}
        />

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
