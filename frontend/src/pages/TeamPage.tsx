import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import {
  Users,
  UserPlus,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ArrowLeft,
  BarChart2,
  Shield,
} from "lucide-react";
import { teamApi, consensusApi } from "../api/client";
import type { TeamMember, ProjectInvitation, ReviewerStats } from "../api/client";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  reviewer: "Reviewer",
  observer: "Observer",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "var(--brand)",
  admin: "#7c3aed",
  reviewer: "#059669",
  observer: "#6b7280",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      style={{
        background: ROLE_COLORS[role] || "#6b7280",
        color: "#fff",
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {ROLE_LABELS[role] || role}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>
      {copied ? <Check size={14} color="#059669" /> : <Copy size={14} color="#6b7280" />}
    </button>
  );
}

export default function TeamPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("reviewer");
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [acceptToken, setAcceptToken] = useState("");
  const [statsTab, setStatsTab] = useState<"team" | "reliability">("team");
  const [reliabilityStage, setReliabilityStage] = useState<"" | "TA" | "FT">("");

  const { data: myRole } = useQuery({
    queryKey: ["team-me", projectId],
    queryFn: () => teamApi.getMyRole(projectId!).then((r) => r.data),
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ["team-members", projectId],
    queryFn: () => teamApi.listMembers(projectId!).then((r) => r.data),
  });

  const { data: invitations = [] } = useQuery({
    queryKey: ["team-invitations", projectId],
    queryFn: () => teamApi.listInvitations(projectId!).then((r) => r.data),
    enabled: myRole?.role === "owner" || myRole?.role === "admin",
  });

  const { data: teamStats = [] } = useQuery({
    queryKey: ["consensus-stats", projectId],
    queryFn: () => consensusApi.getTeamStats(projectId!).then((r) => r.data),
  });

  const { data: reliability } = useQuery({
    queryKey: ["consensus-reliability", projectId, reliabilityStage],
    queryFn: () =>
      consensusApi.getReliability(projectId!, reliabilityStage || undefined).then((r) => r.data),
  });

  const inviteMut = useMutation({
    mutationFn: () => teamApi.invite(projectId!, inviteEmail, inviteRole),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-invitations", projectId] });
      setInviteEmail("");
      setShowInviteForm(false);
    },
  });

  const revokeMut = useMutation({
    mutationFn: (invId: string) => teamApi.revokeInvitation(projectId!, invId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-invitations", projectId] }),
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => teamApi.removeMember(projectId!, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members", projectId] }),
  });

  const roleMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      teamApi.updateMemberRole(projectId!, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members", projectId] }),
  });

  const acceptMut = useMutation({
    mutationFn: () => teamApi.acceptInvite(projectId!, acceptToken),
    onSuccess: () => {
      setAcceptToken("");
      qc.invalidateQueries({ queryKey: ["team-members", projectId] });
    },
  });

  const isAdmin = myRole?.role === "owner" || myRole?.role === "admin";

  const kappaColor = (k: number) => {
    if (k >= 0.8) return "#059669";
    if (k >= 0.6) return "#d97706";
    if (k >= 0.4) return "#f59e0b";
    return "#dc2626";
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Link to={`/projects/${projectId}`} style={{ color: "var(--text-muted)", display: "flex" }}>
          <ArrowLeft size={18} />
        </Link>
        <Users size={22} color="var(--brand)" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Team</h1>
        {myRole && <RoleBadge role={myRole.role} />}
      </div>

      {/* ── Members table ────────────────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Users size={16} /> Members ({members.length})
          </div>
          {isAdmin && (
            <button
              className="btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", fontSize: 13 }}
              onClick={() => setShowInviteForm((v) => !v)}
            >
              <UserPlus size={14} /> Invite
            </button>
          )}
        </div>

        {showInviteForm && (
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "#f8f9fb" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@institution.edu"
                  style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, width: 240 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}
                >
                  <option value="admin">Admin</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="observer">Observer</option>
                </select>
              </div>
              <button
                className="btn-primary"
                disabled={!inviteEmail || inviteMut.isPending}
                onClick={() => inviteMut.mutate()}
                style={{ padding: "6px 14px", fontSize: 13 }}
              >
                {inviteMut.isPending ? "Sending…" : "Create invite link"}
              </button>
            </div>
            {inviteMut.isError && (
              <p style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
                {(inviteMut.error as any)?.response?.data?.detail || "Failed to create invitation"}
              </p>
            )}
          </div>
        )}

        {membersLoading ? (
          <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Loading…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8f9fb" }}>
                {["Name", "Email", "Role", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m: TeamMember) => (
                <tr key={m.user_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 16px", fontSize: 14, fontWeight: 500 }}>{m.name}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-muted)" }}>{m.email}</td>
                  <td style={{ padding: "10px 16px" }}>
                    {isAdmin && !m.is_owner ? (
                      <select
                        value={m.role}
                        onChange={(e) => roleMut.mutate({ userId: m.user_id, role: e.target.value })}
                        style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
                      >
                        <option value="admin">Admin</option>
                        <option value="reviewer">Reviewer</option>
                        <option value="observer">Observer</option>
                      </select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>
                    {!m.is_owner && (isAdmin || m.user_id === myRole?.role) && (
                      <button
                        onClick={() => removeMut.mutate(m.user_id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#dc2626", padding: 4 }}
                        title="Remove member"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Pending invitations ──────────────────────────────────────── */}
      {isAdmin && invitations.length > 0 && (
        <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 14 }}>
            Pending Invitations
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8f9fb" }}>
                {["Email", "Role", "Status", "Invite Link", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv: ProjectInvitation) => {
                const inviteUrl = `${window.location.origin}/accept-invite?token=${inv.token}`;
                return (
                  <tr key={inv.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 16px", fontSize: 13 }}>{inv.email}</td>
                    <td style={{ padding: "10px 16px" }}><RoleBadge role={inv.role} /></td>
                    <td style={{ padding: "10px 16px", fontSize: 12, color: inv.status === "pending" ? "#d97706" : "#059669" }}>
                      {inv.status}
                    </td>
                    <td style={{ padding: "10px 16px", fontSize: 12 }}>
                      {inv.status === "pending" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <code style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 4, fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {inviteUrl}
                          </code>
                          <CopyButton text={inviteUrl} />
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      {inv.status === "pending" && (
                        <button
                          onClick={() => revokeMut.mutate(inv.id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#dc2626", padding: 4 }}
                          title="Revoke invitation"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Accept invite panel ──────────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24, padding: "16px 18px" }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Accept an Invitation</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={acceptToken}
            onChange={(e) => setAcceptToken(e.target.value)}
            placeholder="Paste invite token"
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, flex: 1, maxWidth: 360 }}
          />
          <button
            className="btn-primary"
            disabled={!acceptToken || acceptMut.isPending}
            onClick={() => acceptMut.mutate()}
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            {acceptMut.isPending ? "Joining…" : "Join project"}
          </button>
        </div>
        {acceptMut.isSuccess && (
          <p style={{ color: "#059669", fontSize: 12, marginTop: 8 }}>
            Successfully joined the project as {(acceptMut.data as any)?.data?.role}!
          </p>
        )}
        {acceptMut.isError && (
          <p style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
            Invalid or expired token.
          </p>
        )}
      </section>

      {/* ── Stats & Reliability tabs ─────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {[
            { key: "team", label: "Screening Progress", icon: <BarChart2 size={14} /> },
            { key: "reliability", label: "Inter-rater Reliability", icon: <Shield size={14} /> },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatsTab(tab.key as any)}
              style={{
                padding: "12px 20px",
                border: "none",
                borderBottom: statsTab === tab.key ? "2px solid var(--brand)" : "2px solid transparent",
                background: "none",
                color: statsTab === tab.key ? "var(--brand)" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: statsTab === tab.key ? 600 : 400,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {statsTab === "team" && (
          <div style={{ padding: 0 }}>
            {teamStats.length === 0 ? (
              <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                No screening activity yet.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8f9fb" }}>
                    {["Reviewer", "TA Screened", "TA Included", "TA Excluded", "FT Screened", "FT Included", "FT Excluded", "Extractions"].map((h) => (
                      <th key={h} style={{ padding: "8px 14px", textAlign: h === "Reviewer" ? "left" : "center", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teamStats.map((s: ReviewerStats) => (
                    <tr key={s.reviewer_id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 500 }}>{s.name}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13 }}>{s.ta_screened}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13, color: "#059669" }}>{s.ta_included}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13, color: "#dc2626" }}>{s.ta_excluded}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13 }}>{s.ft_screened}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13, color: "#059669" }}>{s.ft_included}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13, color: "#dc2626" }}>{s.ft_excluded}</td>
                      <td style={{ textAlign: "center", padding: "10px 14px", fontSize: 13, color: "var(--brand)" }}>{s.extractions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {statsTab === "reliability" && (
          <div style={{ padding: "16px 18px" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Stage:</label>
              {(["", "TA", "FT"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setReliabilityStage(s)}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 16,
                    border: "1px solid var(--border)",
                    background: reliabilityStage === s ? "var(--brand)" : "none",
                    color: reliabilityStage === s ? "#fff" : "var(--text)",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {s || "All"}
                </button>
              ))}
            </div>

            {!reliability || reliability.n_pairs === 0 ? (
              <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 24 }}>
                At least two reviewers must screen the same items to compute reliability.
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 16, padding: "12px 16px", background: "#f8f9fb", borderRadius: 8, fontSize: 14 }}>
                  Overall agreement:{" "}
                  <strong style={{ color: "var(--brand)" }}>
                    {reliability.overall_pct_agreement != null ? `${reliability.overall_pct_agreement}%` : "—"}
                  </strong>
                  {" "}across {reliability.n_pairs} reviewer pair{reliability.n_pairs !== 1 ? "s" : ""}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#f8f9fb" }}>
                      {["Reviewer A", "Reviewer B", "Items Both Screened", "Agreement", "Cohen's κ", "Interpretation"].map((h) => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reliability.pairs.map((p, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 12px", fontSize: 13 }}>{p.reviewer_a.name}</td>
                        <td style={{ padding: "10px 12px", fontSize: 13 }}>{p.reviewer_b.name}</td>
                        <td style={{ padding: "10px 12px", fontSize: 13, textAlign: "center" }}>{p.n_items_both}</td>
                        <td style={{ padding: "10px 12px", fontSize: 13, textAlign: "center" }}>
                          {p.pct_agreement != null ? `${p.pct_agreement}%` : "—"}
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 700, color: kappaColor(p.kappa), textAlign: "center" }}>
                          {p.kappa.toFixed(3)}
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-muted)", textTransform: "capitalize" }}>
                          {p.kappa_label}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
                  κ &lt; 0.20 poor · 0.20–0.40 fair · 0.40–0.60 moderate · 0.60–0.80 substantial · &gt;0.80 almost perfect (Landis & Koch, 1977)
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}