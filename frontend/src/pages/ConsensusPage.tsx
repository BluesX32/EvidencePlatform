import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { GitMerge, ArrowLeft, CheckCircle, XCircle, AlertTriangle, Scale } from "lucide-react";
import { consensusApi, teamApi } from "../api/client";
import type { ConflictItem, ConsensusDecision, ReviewerDecision } from "../api/client";

function DecisionChip({ decision }: { decision: string }) {
  const isInclude = decision === "include";
  return (
    <span
      style={{
        padding: "2px 10px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: isInclude ? "#d1fae5" : "#fee2e2",
        color: isInclude ? "#065f46" : "#991b1b",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {isInclude ? <CheckCircle size={12} /> : <XCircle size={12} />}
      {decision}
    </span>
  );
}

function ConflictCard({
  conflict,
  onAdjudicate,
  isAdmin,
}: {
  conflict: ConflictItem;
  onAdjudicate: (conflict: ConflictItem, decision: string) => void;
  isAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);

  // Group decisions by stage
  const byStage: Record<string, ReviewerDecision[]> = {};
  for (const d of conflict.decisions) {
    if (!byStage[d.stage]) byStage[d.stage] = [];
    byStage[d.stage].push(d);
  }

  const handleAdjudicate = (decision: string) => {
    setPendingDecision(decision);
    onAdjudicate(conflict, decision);
  };

  return (
    <div
      style={{
        border: "1px solid #fcd34d",
        borderRadius: 8,
        background: "#fffbeb",
        marginBottom: 12,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: "12px 16px",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <AlertTriangle size={16} color="#d97706" />
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {conflict.item_type === "record" ? "Record" : "Cluster"} conflict · Stage {conflict.stage}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
              ID: {conflict.item_id.slice(0, 8)}…
            </span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {conflict.decisions.map((d, i) => (
              <DecisionChip key={i} decision={d.decision} />
            ))}
          </div>
        </div>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ padding: "0 16px 16px" }}>
          {/* Per-reviewer breakdown */}
          <div style={{ marginBottom: 12 }}>
            {conflict.decisions.map((d, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: i < conflict.decisions.length - 1 ? "1px solid #fef3c7" : "none",
                }}
              >
                <DecisionChip decision={d.decision} />
                <div>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{d.reviewer_name || "Reviewer"}</span>
                  {d.reason_code && (
                    <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
                      [{d.reason_code}]
                    </span>
                  )}
                  {d.notes && (
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{d.notes}</p>
                  )}
                </div>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                  {new Date(d.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>

          {/* Adjudication controls */}
          {isAdmin && (
            <div style={{ background: "white", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                <Scale size={14} color="var(--brand)" /> Adjudicate
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => handleAdjudicate("include")}
                  style={{
                    padding: "6px 16px",
                    background: pendingDecision === "include" ? "#059669" : "#d1fae5",
                    color: pendingDecision === "include" ? "#fff" : "#065f46",
                    border: "1px solid #6ee7b7",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <CheckCircle size={14} /> Include
                </button>
                <button
                  onClick={() => handleAdjudicate("exclude")}
                  style={{
                    padding: "6px 16px",
                    background: pendingDecision === "exclude" ? "#dc2626" : "#fee2e2",
                    color: pendingDecision === "exclude" ? "#fff" : "#991b1b",
                    border: "1px solid #fca5a5",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <XCircle size={14} /> Exclude
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ConsensusPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [stageFilter, setStageFilter] = useState<"" | "TA" | "FT">("");
  const [tab, setTab] = useState<"conflicts" | "resolved">("conflicts");

  const { data: myRole } = useQuery({
    queryKey: ["team-me", projectId],
    queryFn: () => teamApi.getMyRole(projectId!).then((r) => r.data),
  });

  const { data: conflicts = [], isLoading: conflictsLoading } = useQuery({
    queryKey: ["consensus-conflicts", projectId, stageFilter],
    queryFn: () =>
      consensusApi.listConflicts(projectId!, stageFilter || undefined).then((r) => r.data),
  });

  const { data: resolved = [], isLoading: resolvedLoading } = useQuery({
    queryKey: ["consensus-resolved", projectId],
    queryFn: () => consensusApi.listResolved(projectId!).then((r) => r.data),
  });

  const adjudicateMut = useMutation({
    mutationFn: ({
      conflict,
      decision,
    }: {
      conflict: ConflictItem;
      decision: string;
    }) =>
      consensusApi.adjudicate(projectId!, {
        record_id: conflict.record_id,
        cluster_id: conflict.cluster_id,
        stage: conflict.stage,
        decision,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["consensus-conflicts", projectId] });
      qc.invalidateQueries({ queryKey: ["consensus-resolved", projectId] });
    },
  });

  const isAdmin = myRole?.role === "owner" || myRole?.role === "admin";

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Link to={`/projects/${projectId}`} style={{ color: "var(--text-muted)", display: "flex" }}>
          <ArrowLeft size={18} />
        </Link>
        <GitMerge size={22} color="var(--brand)" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Consensus</h1>
      </div>

      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 24 }}>
        {[
          { key: "conflicts", label: `Unresolved Conflicts (${conflicts.length})` },
          { key: "resolved", label: `Resolved (${resolved.length})` },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as any)}
            style={{
              padding: "10px 20px",
              border: "none",
              borderBottom: tab === t.key ? "2px solid var(--brand)" : "2px solid transparent",
              background: "none",
              color: tab === t.key ? "var(--brand)" : "var(--text-muted)",
              fontWeight: tab === t.key ? 600 : 400,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "conflicts" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Stage:</span>
            {(["", "TA", "FT"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStageFilter(s)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 16,
                  border: "1px solid var(--border)",
                  background: stageFilter === s ? "var(--brand)" : "none",
                  color: stageFilter === s ? "#fff" : "var(--text)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {s || "All"}
              </button>
            ))}
          </div>

          {conflictsLoading ? (
            <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40 }}>Loading…</div>
          ) : conflicts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
              <CheckCircle size={32} color="#059669" style={{ marginBottom: 12 }} />
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>No unresolved conflicts</div>
              <div style={{ fontSize: 13 }}>
                All reviewers are in agreement, or only one reviewer has screened items so far.
              </div>
            </div>
          ) : (
            conflicts.map((c: ConflictItem) => (
              <ConflictCard
                key={`${c.item_id}-${c.stage}`}
                conflict={c}
                isAdmin={isAdmin}
                onAdjudicate={(conflict, decision) =>
                  adjudicateMut.mutate({ conflict, decision })
                }
              />
            ))
          )}
        </>
      )}

      {tab === "resolved" && (
        <>
          {resolvedLoading ? (
            <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40 }}>Loading…</div>
          ) : resolved.length === 0 ? (
            <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40 }}>
              No adjudicated decisions yet.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <thead>
                <tr style={{ background: "#f8f9fb" }}>
                  {["Item", "Type", "Stage", "Final Decision", "Date"].map((h) => (
                    <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resolved.map((c: ConsensusDecision) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 14px", fontSize: 12, fontFamily: "monospace" }}>
                      {(c.record_id || c.cluster_id || "").slice(0, 8)}…
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12 }}>
                      {c.record_id ? "record" : "cluster"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 13 }}>{c.stage}</td>
                    <td style={{ padding: "10px 14px" }}><DecisionChip decision={c.decision} /></td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}