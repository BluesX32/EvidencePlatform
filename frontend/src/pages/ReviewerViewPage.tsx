import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, XCircle, Minus, ExternalLink } from "lucide-react";
import { screeningApi, teamApi } from "../api/client";

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span style={{ color: "#94a3b8", fontSize: 12 }}>—</span>;
  if (decision === "include")
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#16a34a", fontSize: 12, fontWeight: 600 }}>
        <CheckCircle2 size={12} /> Include
      </span>
    );
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#dc2626", fontSize: 12, fontWeight: 600 }}>
      <XCircle size={12} /> Exclude
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid var(--border)", borderRadius: 10,
      padding: "14px 18px", minWidth: 110,
    }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#1e293b" }}>{value}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export default function ReviewerViewPage() {
  const { id: projectId, reviewerId } = useParams<{ id: string; reviewerId: string }>();
  const [searchParams] = useSearchParams();
  const reviewerName = searchParams.get("name") ?? "Reviewer";
  const navigate = useNavigate();

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

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem" }}>
        <button
          onClick={() => navigate(`/projects/${projectId}/team`)}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "#64748b", fontSize: 13 }}
        >
          <ArrowLeft size={15} /> Back to Team
        </button>
        <div style={{ width: 1, height: 18, background: "var(--border)" }} />
        <h1 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "#1e293b" }}>
          Viewing as: <span style={{ color: "var(--brand)" }}>{reviewerName}</span>
        </h1>
        <span style={{
          marginLeft: 4, padding: "2px 8px", background: "#fef3c7", color: "#92400e",
          borderRadius: 12, fontSize: 11, fontWeight: 600,
        }}>Read-only</span>
      </div>

      {/* Stats */}
      {s && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: "1.5rem" }}>
          <StatCard label="TA screened" value={s.ta_screened} />
          <StatCard label="TA included" value={s.ta_included} sub={s.ta_screened ? `${Math.round(s.ta_included / s.ta_screened * 100)}%` : undefined} />
          <StatCard label="TA excluded" value={s.ta_excluded} />
          <div style={{ width: 1, background: "var(--border)", margin: "0 4px" }} />
          <StatCard label="FT screened" value={s.ft_screened} />
          <StatCard label="FT included" value={s.ft_included} sub={s.ft_screened ? `${Math.round(s.ft_included / s.ft_screened * 100)}%` : undefined} />
          <StatCard label="FT excluded" value={s.ft_excluded} />
          <div style={{ width: 1, background: "var(--border)", margin: "0 4px" }} />
          <StatCard label="Extractions" value={s.extractions} />
        </div>
      )}

      {/* Quick links */}
      <div style={{ display: "flex", gap: 10, marginBottom: "1.5rem" }}>
        <Link
          to={`/projects/${projectId}/extractions?reviewerId=${reviewerId}&reviewerName=${encodeURIComponent(reviewerName)}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 14px", background: "var(--brand)", color: "#fff",
            borderRadius: 6, fontSize: 13, fontWeight: 500, textDecoration: "none",
          }}
        >
          <ExternalLink size={13} /> View their extractions
        </Link>
      </div>

      {/* Decision table */}
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search title, author, year…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}
          />
          {(["all", "ta_include", "ta_exclude", "ft_include", "ft_exclude"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "4px 10px", borderRadius: 14, fontSize: 12, cursor: "pointer",
                border: "1px solid",
                borderColor: filter === f ? "var(--brand)" : "var(--border)",
                background: filter === f ? "#eef2ff" : "transparent",
                color: filter === f ? "var(--brand)" : "#64748b",
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f === "all" ? "All" : f === "ta_include" ? "TA ✓" : f === "ta_exclude" ? "TA ✗" : f === "ft_include" ? "FT ✓" : "FT ✗"}
            </button>
          ))}
          <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
            {filtered.length} / {summary?.decisions.length ?? 0} papers
          </span>
        </div>

        {isLoading ? (
          <div style={{ padding: 32, textAlign: "center", color: "#94a3b8" }}>Loading…</div>
        ) : isError ? (
          <div style={{ padding: 32, textAlign: "center", color: "#dc2626" }}>Failed to load reviewer data.</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#94a3b8" }}>
            {summary?.decisions.length === 0 ? `${reviewerName} hasn't screened any papers yet.` : "No papers match the current filter."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600, color: "#64748b", fontSize: 11 }}>Title</th>
                <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600, color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>Authors · Year</th>
                <th style={{ padding: "8px 16px", textAlign: "center", fontWeight: 600, color: "#64748b", fontSize: 11 }}>TA</th>
                <th style={{ padding: "8px 16px", textAlign: "center", fontWeight: 600, color: "#64748b", fontSize: 11 }}>FT</th>
                <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600, color: "#64748b", fontSize: 11 }}>Reason / Notes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr key={d.record_id ?? d.cluster_id ?? i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "10px 16px", maxWidth: 380 }}>
                    <div style={{ fontWeight: 500, color: "#1e293b", lineHeight: 1.4 }}>
                      {d.title ?? <span style={{ color: "#94a3b8" }}>(untitled)</span>}
                    </div>
                  </td>
                  <td style={{ padding: "10px 16px", color: "#64748b", whiteSpace: "nowrap", maxWidth: 200 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.authors?.slice(0, 2).join(", ")}
                      {(d.authors?.length ?? 0) > 2 ? " et al." : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{d.year ?? "—"}</div>
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "center" }}>
                    <DecisionBadge decision={d.ta_decision} />
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "center" }}>
                    <DecisionBadge decision={d.ft_decision} />
                  </td>
                  <td style={{ padding: "10px 16px", color: "#64748b", fontSize: 12, maxWidth: 200 }}>
                    {d.reason_code && (
                      <span style={{ display: "block", fontWeight: 500, color: "#475569" }}>{d.reason_code}</span>
                    )}
                    {d.notes && (
                      <span style={{ display: "block", color: "#94a3b8", marginTop: 2 }}>{d.notes}</span>
                    )}
                    {!d.reason_code && !d.notes && <Minus size={12} color="#cbd5e1" />}
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
