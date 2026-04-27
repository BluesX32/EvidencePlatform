/**
 * LabelsPage — labeled articles browser.
 *
 * Left sidebar: label list (filter)
 * Right: stat bar + article table
 */
import { useState, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { labelsApi, projectsApi, type LabeledArticle, type ProjectLabel } from "../api/client";

const PAGE_SIZE = 30;

export default function LabelsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then(r => r.data),
    enabled: !!projectId,
  });

  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId!).then(r => r.data),
    enabled: !!projectId,
  });

  const { data: articlesResp, isLoading } = useQuery({
    queryKey: ["labeled-articles", projectId, activeLabelId, page],
    queryFn: () =>
      labelsApi.listArticles(projectId!, { label_id: activeLabelId ?? undefined, page, page_size: PAGE_SIZE }).then(r => r.data),
    enabled: !!projectId,
  });

  const articles: LabeledArticle[] = articlesResp?.articles ?? [];
  const totalPages = articlesResp?.total_pages ?? 1;
  const total = articlesResp?.total ?? 0;

  const filtered = useMemo(() => {
    if (!search.trim()) return articles;
    const q = search.toLowerCase();
    return articles.filter(a => a.title?.toLowerCase().includes(q) || a.authors.some(au => au.toLowerCase().includes(q)));
  }, [articles, search]);

  const { data: labelCounts } = useQuery({
    queryKey: ["label-counts", projectId, allLabels.map(l => l.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        allLabels.map(lbl =>
          labelsApi.listArticles(projectId!, { label_id: lbl.id, page: 1, page_size: 1 })
            .then(r => [lbl.id, r.data.total] as [string, number])
        )
      );
      return Object.fromEntries(entries);
    },
    enabled: !!projectId && allLabels.length > 0,
  });

  const maxCount = Math.max(...Object.values(labelCounts ?? {}), 1);

  const selectLabel = (id: string | null) => { setActiveLabelId(id); setPage(1); setSearch(""); };

  const openItem = (article: LabeledArticle) => {
    const params = new URLSearchParams({ mode: "screen", source_id: "all" });
    if (article.record_id) params.set("record_id", article.record_id);
    if (article.cluster_id) params.set("cluster_id", article.cluster_id);
    navigate(`/projects/${projectId}/screen?${params.toString()}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        padding: "0.65rem 1.5rem",
        display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0,
      }}>
        <Link to={`/projects/${projectId}`} className="back-link" style={{ margin: 0 }}>
          ← {project?.name ?? "Project"}
        </Link>
        <span style={{ color: "var(--border-strong)" }}>›</span>
        <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.95rem" }}>Labels</span>
        <div style={{ marginLeft: "auto" }}>
          <input
            type="search"
            placeholder="Search title / author…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 220, fontSize: "0.84rem" }}
          />
        </div>
      </div>

      {/* ── Stat bar ─────────────────────────────────────────────────────────── */}
      {allLabels.length > 0 && labelCounts && (
        <div style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "0.85rem 1.5rem",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.6rem" }}>
            Articles per label
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {allLabels.map(lbl => {
              const count = labelCounts[lbl.id] ?? 0;
              const pct = Math.round((count / maxCount) * 100);
              return (
                <div key={lbl.id}
                  onClick={() => selectLabel(activeLabelId === lbl.id ? null : lbl.id)}
                  style={{ display: "flex", alignItems: "center", gap: "0.6rem", cursor: "pointer" }}
                  title={`Filter by "${lbl.name}"`}
                >
                  <div className="truncate" style={{ width: 130, fontSize: "0.8rem", fontWeight: 500, color: "var(--text)" }}>
                    <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: lbl.color, marginRight: 6, verticalAlign: "middle", flexShrink: 0 }} />
                    {lbl.name}
                  </div>
                  <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 4, height: 12, overflow: "hidden" }}>
                    <div style={{
                      width: `${pct}%`, height: "100%", background: lbl.color, borderRadius: 4,
                      transition: "width 0.3s", opacity: activeLabelId && activeLabelId !== lbl.id ? 0.3 : 1,
                    }} />
                  </div>
                  <div style={{ width: 32, fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "right", flexShrink: 0 }}>{count}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <aside style={{
          width: 192, flexShrink: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          padding: "0.85rem 0.6rem",
          overflowY: "auto",
        }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", padding: "0 0.4rem", marginBottom: "0.5rem" }}>
            Filter
          </div>

          <button
            onClick={() => selectLabel(null)}
            style={{
              display: "flex", alignItems: "center", gap: "0.4rem",
              width: "100%", padding: "0.4rem 0.55rem", borderRadius: "var(--radius)",
              border: "none", cursor: "pointer", textAlign: "left", marginBottom: "0.2rem",
              background: activeLabelId === null ? "var(--brand-light)" : "transparent",
              color: activeLabelId === null ? "var(--brand)" : "var(--text)",
              fontWeight: activeLabelId === null ? 700 : 400, fontSize: "0.84rem",
            }}
          >
            All labels
            <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--text-muted)" }}>{total}</span>
          </button>

          {allLabels.map(lbl => (
            <button
              key={lbl.id}
              onClick={() => selectLabel(activeLabelId === lbl.id ? null : lbl.id)}
              style={{
                display: "flex", alignItems: "center", gap: "0.4rem",
                width: "100%", padding: "0.4rem 0.55rem", borderRadius: "var(--radius)",
                border: "none", cursor: "pointer", textAlign: "left", marginBottom: "0.15rem",
                background: activeLabelId === lbl.id ? lbl.color + "1a" : "transparent",
                color: activeLabelId === lbl.id ? lbl.color : "var(--text)",
                fontWeight: activeLabelId === lbl.id ? 600 : 400, fontSize: "0.84rem",
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: lbl.color, flexShrink: 0 }} />
              <span className="truncate" style={{ flex: 1 }}>{lbl.name}</span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", flexShrink: 0 }}>{labelCounts?.[lbl.id] ?? ""}</span>
            </button>
          ))}

          {allLabels.length === 0 && (
            <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", padding: "0.4rem 0.55rem" }}>
              No labels yet.{" "}
              <Link to={`/projects/${projectId}`} style={{ color: "var(--brand)" }}>Create one</Link>
            </p>
          )}
        </aside>

        {/* Table */}
        <main style={{ flex: 1, padding: "1.25rem 1.5rem", overflowY: "auto", overflowX: "auto" }}>
          {isLoading ? (
            <div className="empty-state"><div className="spinner" style={{ margin: "0 auto" }} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState hasLabels={allLabels.length > 0} projectId={projectId!} />
          ) : (
            <>
              <div className="table-wrapper">
                <table className="records-table">
                  <thead>
                    <tr>
                      <th style={{ width: "42%" }}>Title</th>
                      <th style={{ width: 52 }}>Year</th>
                      <th style={{ width: "18%" }}>Authors</th>
                      <th style={{ width: "12%" }}>Sources</th>
                      <th>Labels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((art, i) => (
                      <ArticleRow key={art.record_id ?? art.cluster_id ?? i} article={art} onOpen={openItem} />
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="pagination">
                  <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
                  <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
                  <span>Page {page} of {totalPages}</span>
                  <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
                  <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>»</button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ArticleRow({ article, onOpen }: { article: LabeledArticle; onOpen: (a: LabeledArticle) => void }) {
  return (
    <tr>
      <td style={{ verticalAlign: "top", maxWidth: 0 }}>
        <button
          onClick={() => onOpen(article)}
          className="truncate"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--brand)", fontSize: "0.875rem", textAlign: "left",
            padding: 0, display: "block", width: "100%",
            textDecoration: "underline", textDecorationColor: "transparent",
            transition: "text-decoration-color 0.15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.textDecorationColor = "var(--brand)")}
          onMouseLeave={e => (e.currentTarget.style.textDecorationColor = "transparent")}
        >
          {article.title ?? <span style={{ color: "var(--text-muted)" }}>(no title)</span>}
        </button>
      </td>
      <td style={{ verticalAlign: "top", color: "var(--text-muted)" }}>{article.year ?? "—"}</td>
      <td style={{ verticalAlign: "top", maxWidth: 0 }}>
        <span className="truncate" style={{ display: "block" }}>
          {article.authors.slice(0, 2).join("; ")}{article.authors.length > 2 ? " …" : ""}
        </span>
      </td>
      <td style={{ verticalAlign: "top" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {article.source_names.map(s => (
            <span key={s} className="badge" style={{ fontSize: "0.72rem" }}>{s}</span>
          ))}
        </div>
      </td>
      <td style={{ verticalAlign: "top" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {article.labels.map(lbl => (
            <span key={lbl.id} style={{
              fontSize: "0.72rem", padding: "2px 8px", borderRadius: "var(--radius-full)",
              background: lbl.color, color: "#fff", fontWeight: 600, whiteSpace: "nowrap",
            }}>
              {lbl.name}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function EmptyState({ hasLabels, projectId }: { hasLabels: boolean; projectId: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">🏷️</div>
      {hasLabels ? (
        <>
          <h3>No articles labeled yet</h3>
          <p>Open the <Link to={`/projects/${projectId}/screen`}>Screening Workspace</Link> and apply labels to articles.</p>
        </>
      ) : (
        <>
          <h3>No labels defined yet</h3>
          <p>Go to the <Link to={`/projects/${projectId}`}>Project page</Link> to create labels.</p>
        </>
      )}
    </div>
  );
}
