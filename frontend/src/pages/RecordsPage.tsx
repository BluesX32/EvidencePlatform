import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { recordsApi } from "../api/client";
import RecordsTable from "../components/RecordsTable";

export default function RecordsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseInt(searchParams.get("page") ?? "1");
  const sort = searchParams.get("sort") ?? "year_desc";
  const q = searchParams.get("q") ?? "";

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

  const { data, isLoading } = useQuery({
    queryKey: ["records", projectId, page, sort, q],
    queryFn: () => recordsApi.list(projectId!, { page, per_page: 50, q: q || undefined, sort }).then((r) => r.data),
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

        <RecordsTable
          records={data?.records ?? []}
          sort={sort}
          onSortChange={setSort}
          isLoading={isLoading}
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
