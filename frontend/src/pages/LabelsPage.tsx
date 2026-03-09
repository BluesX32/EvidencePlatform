/**
 * LabelsPage — interactive visualization of labeled articles.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────────────┐
 *  │  Header: project name · "Labels" breadcrumb          │
 *  ├──────────────────────────────────────────────────────┤
 *  │  Stats bar: horizontal bar chart per label           │
 *  ├─────────────┬────────────────────────────────────────┤
 *  │  Left panel │  Article table                         │
 *  │  Label list │  (title, year, sources, labels)        │
 *  │  (filters)  │  Pagination                            │
 *  └─────────────┴────────────────────────────────────────┘
 *
 * Interactive:
 *  • Click a label chip in the sidebar → filters the table to that label
 *  • Click "All" → clears filter
 *  • Click article title → opens ScreeningWorkspace for that item
 *  • Search bar → client-side title/author filter
 */
import { useState, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  labelsApi,
  projectsApi,
  type LabeledArticle,
  type ProjectLabel,
} from "../api/client";

const PAGE_SIZE = 30;

export default function LabelsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  // ── Data fetching ────────────────────────────────────────────────────────

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: allLabels = [] } = useQuery<ProjectLabel[]>({
    queryKey: ["labels", projectId],
    queryFn: () => labelsApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  const { data: articlesResp, isLoading } = useQuery({
    queryKey: ["labeled-articles", projectId, activeLabelId, page],
    queryFn: () =>
      labelsApi
        .listArticles(projectId!, {
          label_id: activeLabelId ?? undefined,
          page,
          page_size: PAGE_SIZE,
        })
        .then((r) => r.data),
    enabled: !!projectId,
  });

  const articles: LabeledArticle[] = articlesResp?.articles ?? [];
  const totalPages = articlesResp?.total_pages ?? 1;
  const total = articlesResp?.total ?? 0;

  // ── Client-side search filter ────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!search.trim()) return articles;
    const q = search.toLowerCase();
    return articles.filter(
      (a) =>
        a.title?.toLowerCase().includes(q) ||
        a.authors.some((au) => au.toLowerCase().includes(q))
    );
  }, [articles, search]);

  // ── Label usage counts (from the current full page, for the stat bar) ────
  // We build a per-label count from the full server-side dataset by looking
  // at the total returned in each label-filtered call — done lazily via
  // individual label queries below.
  const { data: labelCounts } = useQuery({
    queryKey: ["label-counts", projectId, allLabels.map((l) => l.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        allLabels.map((lbl) =>
          labelsApi
            .listArticles(projectId!, { label_id: lbl.id, page: 1, page_size: 1 })
            .then((r) => [lbl.id, r.data.total] as [string, number])
        )
      );
      return Object.fromEntries(entries);
    },
    enabled: !!projectId && allLabels.length > 0,
  });

  const maxCount = Math.max(...Object.values(labelCounts ?? {}), 1);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const selectLabel = (id: string | null) => {
    setActiveLabelId(id);
    setPage(1);
    setSearch("");
  };

  const openItem = (article: LabeledArticle) => {
    const params = new URLSearchParams({ mode: "screen", source_id: "all" });
    if (article.record_id) params.set("record_id", article.record_id);
    if (article.cluster_id) params.set("cluster_id", article.cluster_id);
    navigate(`/projects/${projectId}/screen?${params.toString()}`);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb", fontFamily: "system-ui, sans-serif" }}>
      {/* ── Top bar ── */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 24px", display: "flex", alignItems: "center", gap: 8 }}>
        <Link to={`/projects/${projectId}`} style={{ color: "#6366f1", textDecoration: "none", fontWeight: 500 }}>
          {project?.name ?? "Project"}
        </Link>
        <span style={{ color: "#9ca3af" }}>›</span>
        <span style={{ fontWeight: 600, color: "#111827" }}>Labels</span>
        <div style={{ marginLeft: "auto" }}>
          <input
            type="search"
            placeholder="Search title / author…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 13,
              width: 220,
              outline: "none",
            }}
          />
        </div>
      </div>

      {/* ── Stat bar ── */}
      {allLabels.length > 0 && labelCounts && (
        <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 24px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
            Articles per label
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {allLabels.map((lbl) => {
              const count = labelCounts[lbl.id] ?? 0;
              const pct = Math.round((count / maxCount) * 100);
              return (
                <div
                  key={lbl.id}
                  onClick={() => selectLabel(activeLabelId === lbl.id ? null : lbl.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                  title={`Filter by "${lbl.name}"`}
                >
                  <div style={{ width: 120, fontSize: 12, fontWeight: 500, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: lbl.color,
                        marginRight: 6,
                        verticalAlign: "middle",
                      }}
                    />
                    {lbl.name}
                  </div>
                  <div style={{ flex: 1, background: "#f3f4f6", borderRadius: 4, height: 14, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: lbl.color,
                        borderRadius: 4,
                        transition: "width 0.3s",
                        opacity: activeLabelId && activeLabelId !== lbl.id ? 0.35 : 1,
                      }}
                    />
                  </div>
                  <div style={{ width: 36, fontSize: 12, color: "#6b7280", textAlign: "right" }}>{count}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ display: "flex", gap: 0 }}>
        {/* Sidebar */}
        <aside
          style={{
            width: 200,
            minHeight: "calc(100vh - 120px)",
            background: "#fff",
            borderRight: "1px solid #e5e7eb",
            padding: "16px 12px",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Filter
          </div>

          <button
            onClick={() => selectLabel(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: activeLabelId === null ? "#ede9fe" : "transparent",
              color: activeLabelId === null ? "#6366f1" : "#374151",
              fontWeight: activeLabelId === null ? 600 : 400,
              fontSize: 13,
              textAlign: "left",
              marginBottom: 4,
            }}
          >
            All labels
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af" }}>{total}</span>
          </button>

          {allLabels.map((lbl) => (
            <button
              key={lbl.id}
              onClick={() => selectLabel(activeLabelId === lbl.id ? null : lbl.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: activeLabelId === lbl.id ? lbl.color + "22" : "transparent",
                color: activeLabelId === lbl.id ? lbl.color : "#374151",
                fontWeight: activeLabelId === lbl.id ? 600 : 400,
                fontSize: 13,
                textAlign: "left",
                marginBottom: 2,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: lbl.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lbl.name}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{labelCounts?.[lbl.id] ?? ""}</span>
            </button>
          ))}

          {allLabels.length === 0 && (
            <p style={{ fontSize: 12, color: "#9ca3af", padding: "6px 10px" }}>
              No labels yet.{" "}
              <Link to={`/projects/${projectId}`} style={{ color: "#6366f1" }}>
                Create one
              </Link>
            </p>
          )}
        </aside>

        {/* Table */}
        <main style={{ flex: 1, padding: 24, overflowX: "auto" }}>
          {isLoading ? (
            <p style={{ color: "#9ca3af" }}>Loading…</p>
          ) : filtered.length === 0 ? (
            <EmptyState hasLabels={allLabels.length > 0} projectId={projectId!} />
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
                    <Th style={{ width: "40%" }}>Title</Th>
                    <Th style={{ width: 60 }}>Year</Th>
                    <Th style={{ width: "20%" }}>Authors</Th>
                    <Th style={{ width: "15%" }}>Sources</Th>
                    <Th>Labels</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((art, i) => (
                    <ArticleRow key={art.record_id ?? art.cluster_id ?? i} article={art} onOpen={openItem} />
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20, justifyContent: "center" }}>
                  <PageBtn disabled={page <= 1} onClick={() => setPage(1)}>«</PageBtn>
                  <PageBtn disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</PageBtn>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    Page {page} of {totalPages}
                  </span>
                  <PageBtn disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</PageBtn>
                  <PageBtn disabled={page >= totalPages} onClick={() => setPage(totalPages)}>»</PageBtn>
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

function ArticleRow({
  article,
  onOpen,
}: {
  article: LabeledArticle;
  onOpen: (a: LabeledArticle) => void;
}) {
  return (
    <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <button
          onClick={() => onOpen(article)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#4338ca",
            fontSize: 13,
            textAlign: "left",
            padding: 0,
            textDecoration: "underline",
            textDecorationColor: "transparent",
            transition: "text-decoration-color 0.15s",
          }}
          onMouseEnter={(e) =>
            ((e.target as HTMLButtonElement).style.textDecorationColor = "#4338ca")
          }
          onMouseLeave={(e) =>
            ((e.target as HTMLButtonElement).style.textDecorationColor = "transparent")
          }
        >
          {article.title ?? <span style={{ color: "#9ca3af" }}>(no title)</span>}
        </button>
      </td>
      <td style={{ padding: "10px 8px", color: "#6b7280", verticalAlign: "top" }}>{article.year ?? "—"}</td>
      <td style={{ padding: "10px 8px", color: "#374151", verticalAlign: "top" }}>
        {article.authors.slice(0, 3).join("; ")}
        {article.authors.length > 3 && " …"}
      </td>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {article.source_names.map((s) => (
            <span
              key={s}
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 999,
                background: "#f3f4f6",
                color: "#6b7280",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      </td>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {article.labels.map((lbl) => (
            <span
              key={lbl.id}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background: lbl.color,
                color: "#fff",
                fontWeight: 500,
              }}
            >
              {lbl.name}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        padding: "8px 8px",
        textAlign: "left",
        fontSize: 11,
        fontWeight: 700,
        color: "#6b7280",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function PageBtn({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: "1px solid #d1d5db",
        background: disabled ? "#f9fafb" : "#fff",
        color: disabled ? "#d1d5db" : "#374151",
        borderRadius: 6,
        padding: "4px 10px",
        cursor: disabled ? "default" : "pointer",
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

function EmptyState({ hasLabels, projectId }: { hasLabels: boolean; projectId: string }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: "#9ca3af" }}>
      {hasLabels ? (
        <>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏷️</div>
          <p>No articles have been labeled yet.</p>
          <p style={{ fontSize: 13 }}>
            Open the{" "}
            <Link to={`/projects/${projectId}/screen`} style={{ color: "#6366f1" }}>
              Screening Workspace
            </Link>{" "}
            and apply labels to articles.
          </p>
        </>
      ) : (
        <>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏷️</div>
          <p>No labels defined yet.</p>
          <p style={{ fontSize: 13 }}>
            Go to the{" "}
            <Link to={`/projects/${projectId}`} style={{ color: "#6366f1" }}>
              Project page
            </Link>{" "}
            to create labels.
          </p>
        </>
      )}
    </div>
  );
}
