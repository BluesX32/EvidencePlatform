import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Minus, ExternalLink } from "lucide-react";
import { screeningApi } from "../api/client";

// ── Decision badge ─────────────────────────────────────────────────────────────

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span style={{ color: "#cbd5e1", fontSize: 12 }}>—</span>;
  if (decision === "include")
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        background: "#dcfce7", color: "#15803d",
        padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
      }}>
        <CheckCircle2 size={11} /> Include
      </span>
    );
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      background: "#fee2e2", color: "#dc2626",
      padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
    }}>
      <XCircle size={11} /> Exclude
    </span>
  );
}

// ── Stat group ─────────────────────────────────────────────────────────────────

function StatGroup({
  label, screened, included, excluded, color,
}: {
  label: string; screened: number; included: number; excluded: number; color: string;
}) {
  const pct = screened > 0 ? Math.round(included / screened * 100) : 0;
  return (
    <div style={{
      flex: 1, background: "#fff", border: "1px solid var(--border)",
      borderRadius: 12, padding: "16px 20px", minWidth: 220,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
          color, background: color + "18", padding: "3px 8px", borderRadius: 6,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 22, fontWeight: 800, color: "#1e293b" }}>{screened}</span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", marginBottom: 10 }}>
        {screened > 0 && (
          <div style={{
            height: "100%", width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
            borderRadius: 99, transition: "width 0.4s ease",
          }} />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#15803d" }}>{included}</div>
          <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>Included</div>
        </div>
        <div style={{ width: 1, background: "#f1f5f9" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#dc2626" }}>{excluded}</div>
          <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>Excluded</div>
        </div>
        <div style={{ width: 1, background: "#f1f5f9" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color }}>{screened > 0 ? pct + "%" : "—"}</div>
          <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>Incl. rate</div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReviewerViewPage() {
  const { id: projectId, reviewerId } = useParams<{ id: string; reviewerId: string }>();
  const [searchParams] = useSearchParams();
  const reviewerName = searchParams.get("name") ?? "Reviewer";

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "ta_include" | "ta_exclude" | "ft_include" | "ft_exclude">("all");

  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ["reviewer-summary", projectId, reviewerId],
    queryFn: () => screeningApi.getReviewerSummary(projectId!, reviewerId!).then(r => r.data),
    enabled: !!projectId && !!reviewerId,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    if (!summary) return [];
    let items = summary.decisions;
    if (filter === "ta_include") items = items.filter(d => d.ta_decision === "include");
    else if (filter === "ta_exclude") items = items.filter(d => d.ta_decision === "exclude");
    else if (filter === "ft_include") items = items.filter(d => d.ft_decision === "include");
    else if (filter === "ft_exclude") items = items.filter(d => d.ft_decision === "exclude");
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(d =>
        (d.title ?? "").toLowerCase().includes(q) ||
        (d.authors ?? []).join(" ").toLowerCase().includes(q) ||
        String(d.year ?? "").includes(q)
      );
    }
    return items;
  }, [summary, filter, search]);

  const s = summary?.stats;

  const FILTERS: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "ta_include", label: "TA ✓" },
    { key: "ta_exclude", label: "TA ✗" },
    { key: "ft_include", label: "FT ✓" },
    { key: "ft_exclude", label: "FT ✗" },
  ];

  return (
    <div style={{ padding: "1.75rem 2rem", maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Page title row ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#1e293b" }}>
            {reviewerName}'s Activity
          </h1>
          {s && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>
              {s.ta_screened} papers screened · {s.ft_included} FT included · {s.extractions} extracted
            </div>
          )}
        </div>
        <Link
          to={`/projects/${projectId}/extractions?reviewerId=${reviewerId}&reviewerName=${encodeURIComponent(reviewerName)}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "7px 16px", background: "var(--brand)", color: "#fff",
            borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none",
          }}
        >
          <ExternalLink size={13} /> Extractions
        </Link>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────────── */}
      {s && (
        <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <StatGroup
            label="Title / Abstract"
            screened={s.ta_screened}
            included={s.ta_included}
            excluded={s.ta_excluded}
            color="#6366f1"
          />
          <StatGroup
            label="Full Text"
            screened={s.ft_screened}
            included={s.ft_included}
            excluded={s.ft_excluded}
            color="#0891b2"
          />
          <div style={{
            background: "#fff", border: "1px solid var(--border)", borderRadius: 12,
            padding: "16px 20px", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", minWidth: 120,
          }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#7c3aed" }}>{s.extractions}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.07em" }}>
              Extracted
            </div>
          </div>
        </div>
      )}

      {/* ── Decision table ────────────────────────────────────────────────── */}
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid #f1f5f9",
          display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
          background: "#fafbfc",
        }}>
          <input
            type="text"
            placeholder="Search title, author, year…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: 200, padding: "6px 10px",
              border: "1px solid var(--border)", borderRadius: 6, fontSize: 13,
              outline: "none", background: "#fff",
            }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: "4px 11px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  border: "1.5px solid",
                  borderColor: filter === f.key ? "#6366f1" : "var(--border)",
                  background: filter === f.key ? "#eef2ff" : "transparent",
                  color: filter === f.key ? "#4f46e5" : "#64748b",
                  fontWeight: filter === f.key ? 700 : 400,
                  transition: "all 0.15s",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto", whiteSpace: "nowrap" }}>
            {filtered.length} / {summary?.decisions.length ?? 0}
          </span>
        </div>

        {/* Body */}
        {isLoading ? (
          <div style={{ padding: 48, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
            Loading…
          </div>
        ) : isError ? (
          <div style={{ padding: 48, textAlign: "center", color: "#dc2626", fontSize: 13 }}>
            Failed to load reviewer data.
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
            <div style={{ fontWeight: 600, color: "#475569", marginBottom: 4 }}>
              {summary?.decisions.length === 0
                ? `${reviewerName} hasn't screened any papers yet`
                : "No papers match the current filter"}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              {summary?.decisions.length === 0
                ? "Papers will appear here once they start screening"
                : "Try adjusting the filter or search term"}
            </div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #f1f5f9" }}>
                <th style={{ padding: "9px 16px", textAlign: "left", fontWeight: 600, color: "#94a3b8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>Title</th>
                <th style={{ padding: "9px 16px", textAlign: "left", fontWeight: 600, color: "#94a3b8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>Authors / Year</th>
                <th style={{ padding: "9px 16px", textAlign: "center", fontWeight: 600, color: "#94a3b8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>TA</th>
                <th style={{ padding: "9px 16px", textAlign: "center", fontWeight: 600, color: "#94a3b8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>FT</th>
                <th style={{ padding: "9px 16px", textAlign: "left", fontWeight: 600, color: "#94a3b8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr
                  key={d.record_id ?? d.cluster_id ?? i}
                  style={{
                    borderBottom: "1px solid #f8fafc",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#fafbfc")}
                  onMouseLeave={e => (e.currentTarget.style.background = "")}
                >
                  <td style={{ padding: "11px 16px", maxWidth: 380 }}>
                    <div style={{ fontWeight: 500, color: "#1e293b", lineHeight: 1.4, fontSize: 13 }}>
                      {d.title ?? <span style={{ color: "#94a3b8" }}>(untitled)</span>}
                    </div>
                  </td>
                  <td style={{ padding: "11px 16px", whiteSpace: "nowrap", maxWidth: 180 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#475569", fontSize: 12 }}>
                      {d.authors?.slice(0, 2).join(", ")}
                      {(d.authors?.length ?? 0) > 2 ? " et al." : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{d.year ?? "—"}</div>
                  </td>
                  <td style={{ padding: "11px 16px", textAlign: "center" }}>
                    <DecisionBadge decision={d.ta_decision} />
                  </td>
                  <td style={{ padding: "11px 16px", textAlign: "center" }}>
                    <DecisionBadge decision={d.ft_decision} />
                  </td>
                  <td style={{ padding: "11px 16px", maxWidth: 200 }}>
                    {d.reason_code && (
                      <span style={{ display: "block", fontSize: 12, fontWeight: 500, color: "#475569" }}>{d.reason_code}</span>
                    )}
                    {d.notes && (
                      <span style={{ display: "block", fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{d.notes}</span>
                    )}
                    {!d.reason_code && !d.notes && <Minus size={12} color="#e2e8f0" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
