import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { CheckCircle, XCircle, AlertTriangle, Scale, Sparkles } from "lucide-react";
import { consensusApi, teamApi, aiApi, aiPilotApi } from "../api/client";
import type { ConflictItem, ConsensusDecision, ReviewerDecision } from "../api/client";

// ── Decision chip ─────────────────────────────────────────────────────────────

function DecisionChip({ decision }: { decision: string }) {
  const isInclude = decision === "include";
  return (
    <span className={`badge ${isInclude ? "badge-success" : "badge-danger"}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {isInclude ? <CheckCircle size={11} /> : <XCircle size={11} />}
      {decision}
    </span>
  );
}

// ── Conflict card ─────────────────────────────────────────────────────────────

function ConflictCard({ conflict, onAdjudicate, isAdmin, projectId }: {
  conflict: ConflictItem;
  onAdjudicate: (c: ConflictItem, decision: string) => void;
  isAdmin: boolean;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<{ decision: string; rationale: string } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  async function askAI() {
    setAiLoading(true);
    setAiError(null);
    setAiSuggestion(null);
    try {
      const d0 = conflict.decisions[0];
      const d1 = conflict.decisions[1] ?? d0;
      const res = await aiApi.suggestResolution(projectId, {
        reviewer_a_decision: d0.decision,
        reviewer_b_decision: d1.decision,
        reviewer_a_notes: d0.notes ?? undefined,
        reviewer_b_notes: d1.notes ?? undefined,
        record_id: conflict.record_id ?? undefined,
        cluster_id: conflict.cluster_id ?? undefined,
      });
      setAiSuggestion(res.data);
    } catch {
      setAiError("AI suggestion failed.");
    } finally {
      setAiLoading(false);
    }
  }

  const byStage: Record<string, ReviewerDecision[]> = {};
  for (const d of conflict.decisions) {
    if (!byStage[d.stage]) byStage[d.stage] = [];
    byStage[d.stage].push(d);
  }

  function handleAdjudicate(decision: string) {
    setPendingDecision(decision);
    onAdjudicate(conflict, decision);
  }

  return (
    <div style={{
      border: "1px solid var(--warning-border)",
      borderRadius: "var(--radius-lg)",
      background: "var(--warning-light)",
      marginBottom: "0.75rem",
      overflow: "hidden",
    }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ padding: "0.75rem 1rem", cursor: "pointer", display: "flex",
                 justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0, flex: 1 }}>
          <AlertTriangle size={15} color="var(--warning)" style={{ flexShrink: 0 }} />
          <div className="min-w-0" style={{ flex: 1 }}>
            <span style={{ fontSize: "0.84rem", fontWeight: 600, color: "var(--text)" }}>
              {conflict.item_type === "record" ? "Record" : "Cluster"} conflict · Stage {conflict.stage}
            </span>
            <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
              ID: {conflict.item_id.slice(0, 8)}…
            </span>
          </div>
          <div style={{ display: "flex", gap: "0.3rem", flexShrink: 0 }}>
            {conflict.decisions.map((d, i) => <DecisionChip key={i} decision={d.decision} />)}
          </div>
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "0 1rem 1rem" }}>
          <div style={{ marginBottom: "0.75rem" }}>
            {conflict.decisions.map((d, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: "0.6rem",
                padding: "0.5rem 0",
                borderBottom: i < conflict.decisions.length - 1 ? "1px solid var(--warning-border)" : "none",
              }}>
                <DecisionChip decision={d.decision} />
                <div className="min-w-0" style={{ flex: 1 }}>
                  <span style={{ fontSize: "0.84rem", fontWeight: 500 }}>{d.reviewer_name || "Reviewer"}</span>
                  {d.reason_code && (
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "0.4rem" }}>
                      [{d.reason_code}]
                    </span>
                  )}
                  {d.notes && (
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>{d.notes}</p>
                  )}
                </div>
                <span style={{ fontSize: "0.73rem", color: "var(--text-muted)", flexShrink: 0 }}>
                  {new Date(d.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>

          {isAdmin && (
            <div className="card" style={{ padding: "0.75rem 1rem" }}>
              <div className="section-title" style={{ marginBottom: "0.6rem" }}>
                <Scale size={13} /> Adjudicate
              </div>
              {/* AI suggestion row */}
              <div style={{ marginBottom: "0.6rem", display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
                <button
                  onClick={askAI}
                  disabled={aiLoading}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "0.28rem 0.7rem", borderRadius: "var(--radius)", fontSize: "0.78rem", fontWeight: 600,
                    background: aiLoading ? "#f3f4f6" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                    color: aiLoading ? "#9ca3af" : "#fff", border: "none", cursor: "pointer",
                  }}
                >
                  <Sparkles size={12} /> {aiLoading ? "Asking AI…" : "Ask AI"}
                </button>
                {aiError && <span style={{ fontSize: "0.78rem", color: "var(--danger)" }}>{aiError}</span>}
                {aiSuggestion && (
                  <div style={{
                    flex: 1, background: aiSuggestion.decision === "include" ? "var(--success-light)" : "var(--danger-light)",
                    border: `1px solid ${aiSuggestion.decision === "include" ? "var(--success-border)" : "var(--danger-border)"}`,
                    borderRadius: "var(--radius)", padding: "0.4rem 0.7rem",
                  }}>
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: aiSuggestion.decision === "include" ? "var(--success)" : "var(--danger)", textTransform: "uppercase" }}>
                      AI suggests: {aiSuggestion.decision}
                    </span>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--text-muted)" }}>{aiSuggestion.rationale}</p>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={() => handleAdjudicate("include")}
                  className={pendingDecision === "include" ? "btn-primary btn-sm" : "btn-sm"}
                  style={pendingDecision === "include" ? {} : {
                    background: "var(--success-light)", color: "var(--success)",
                    border: "1px solid var(--success-border)", cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "0.28rem 0.65rem", borderRadius: "var(--radius)", fontSize: "0.78rem", fontWeight: 600,
                  }}
                >
                  <CheckCircle size={13} /> Include
                </button>
                <button
                  onClick={() => handleAdjudicate("exclude")}
                  className={pendingDecision === "exclude" ? "btn-danger btn-sm" : "btn-sm"}
                  style={pendingDecision === "exclude" ? {} : {
                    background: "var(--danger-light)", color: "var(--danger)",
                    border: "1px solid var(--danger-border)", cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "0.28rem 0.65rem", borderRadius: "var(--radius)", fontSize: "0.78rem", fontWeight: 600,
                  }}
                >
                  <XCircle size={13} /> Exclude
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConsensusPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [stageFilter, setStageFilter] = useState<"" | "TA" | "FT">("");
  const [tab, setTab] = useState<"conflicts" | "resolved">("conflicts");

  const { data: myRole } = useQuery({
    queryKey: ["team-me", projectId],
    queryFn: () => teamApi.getMyRole(projectId!).then(r => r.data),
  });
  const { data: conflicts = [], isLoading: conflictsLoading } = useQuery({
    queryKey: ["consensus-conflicts", projectId, stageFilter],
    queryFn: () => consensusApi.listConflicts(projectId!, stageFilter || undefined).then(r => r.data),
  });
  const { data: resolved = [], isLoading: resolvedLoading } = useQuery({
    queryKey: ["consensus-resolved", projectId],
    queryFn: () => consensusApi.listResolved(projectId!).then(r => r.data),
  });

  const adjudicateMut = useMutation({
    mutationFn: ({ conflict, decision }: { conflict: ConflictItem; decision: string }) =>
      consensusApi.adjudicate(projectId!, {
        record_id: conflict.record_id, cluster_id: conflict.cluster_id,
        stage: conflict.stage, decision,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consensus-conflicts", projectId] });
      qc.invalidateQueries({ queryKey: ["consensus-resolved", projectId] });
    },
  });

  const resolveAllMut = useMutation({
    mutationFn: () => aiPilotApi.resolveAll(projectId!, { model: "anthropic/claude-haiku-4-5" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consensus-conflicts", projectId] });
      qc.invalidateQueries({ queryKey: ["consensus-resolved", projectId] });
    },
  });

  const isAdmin = myRole?.role === "owner" || myRole?.role === "admin";

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1>Consensus</h1>
          <span className="subtitle">Review and adjudicate conflicting screening decisions</span>
        </div>
        {isAdmin && conflicts.length > 0 && (
          <button
            disabled={resolveAllMut.isPending}
            onClick={() => resolveAllMut.mutate()}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "0.3rem 0.7rem", borderRadius: "0.375rem", border: "none",
              background: resolveAllMut.isPending ? "#a5b4fc" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
              color: "#fff", fontSize: "0.78rem", fontWeight: 600,
              cursor: resolveAllMut.isPending ? "default" : "pointer",
            }}
            title="Use AI to auto-adjudicate all unresolved conflicts"
          >
            ✦ {resolveAllMut.isPending ? "Resolving…" : `Resolve All with AI (${conflicts.length})`}
          </button>
        )}
      </header>

      {/* ── Tabs ─────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: "1.25rem" }}>
        {[
          { key: "conflicts", label: `Unresolved (${conflicts.length})` },
          { key: "resolved",  label: `Resolved (${resolved.length})` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as "conflicts" | "resolved")}
            style={{
              padding: "0.6rem 1.1rem",
              border: "none",
              borderBottom: tab === t.key ? "2px solid var(--brand)" : "2px solid transparent",
              background: "none",
              color: tab === t.key ? "var(--brand)" : "var(--text-muted)",
              fontWeight: tab === t.key ? 700 : 400,
              fontSize: "0.875rem",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Conflicts tab ────────────────────────────────────────────────────── */}
      {tab === "conflicts" && (
        <>
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginRight: "0.2rem" }}>Stage:</span>
            {(["", "TA", "FT"] as const).map(s => (
              <button
                key={s}
                onClick={() => setStageFilter(s)}
                className={stageFilter === s ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              >
                {s || "All"}
              </button>
            ))}
          </div>

          {conflictsLoading ? (
            <div className="empty-state"><div className="spinner" style={{ margin: "0 auto" }} /></div>
          ) : conflicts.length === 0 ? (
            <div className="empty-state">
              <CheckCircle size={32} color="var(--success)" style={{ marginBottom: 12 }} />
              <h3>No unresolved conflicts</h3>
              <p>All reviewers are in agreement, or only one reviewer has screened items so far.</p>
            </div>
          ) : (
            conflicts.map((c: ConflictItem) => (
              <ConflictCard
                key={`${c.item_id}-${c.stage}`}
                conflict={c}
                isAdmin={isAdmin}
                projectId={projectId!}
                onAdjudicate={(conflict, decision) => adjudicateMut.mutate({ conflict, decision })}
              />
            ))
          )}
        </>
      )}

      {/* ── Resolved tab ─────────────────────────────────────────────────────── */}
      {tab === "resolved" && (
        resolvedLoading ? (
          <div className="empty-state"><div className="spinner" style={{ margin: "0 auto" }} /></div>
        ) : resolved.length === 0 ? (
          <div className="empty-state"><p>No adjudicated decisions yet.</p></div>
        ) : (
          <div className="table-wrapper">
            <table className="records-table">
              <thead>
                <tr>
                  {["Item", "Type", "Stage", "Final Decision", "Date"].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resolved.map((c: ConsensusDecision) => (
                  <tr key={c.id}>
                    <td style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>
                      {(c.record_id || c.cluster_id || "").slice(0, 8)}…
                    </td>
                    <td>{c.record_id ? "record" : "cluster"}</td>
                    <td>{c.stage}</td>
                    <td><DecisionChip decision={c.decision} /></td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
