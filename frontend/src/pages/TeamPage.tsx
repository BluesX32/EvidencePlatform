import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import {
  Users,
  UserPlus,
  Trash2,
  Copy,
  Check,
  ArrowLeft,
  BarChart2,
  Shield,
  X,
  BookMarked,
} from "lucide-react";
import { teamApi, consensusApi, recordsApi } from "../api/client";
import type { TeamMember, ProjectInvitation, ReviewerStats, InviteResult, RecordItem } from "../api/client";

// ── Constants ────────────────────────────────────────────────────────────────

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

// Stage presets — each stage defines both the data-visibility level (data_stage)
// and the default set of nav modules available, following the zipper data-flow model:
//   Import → Overlap → [zipper] → Screening → Extraction → Concepts → Analysis
//
// SHARED (before zipper):   records, overlap clusters
// PER-REVIEWER (after zipper): screening decisions, extractions, concept forms,
//                              concept taxonomy (each reviewer sees their own aggregate),
//                              code assignments in thematic analysis
// SHARED again (synthesis): thematic codebook structure, ontology nodes
const STAGE_PRESETS = [
  {
    label: "Import only",
    value: "import" as string | null,
    description: "Shared records and dedup results only",
    sections: ["overview", "import", "records"],
  },
  {
    label: "Up to Overlap",
    value: "overlap" as string | null,
    description: "Can also see cross-source overlap clusters",
    sections: ["overview", "import", "records", "overlap"],
  },
  {
    label: "Up to Screening",
    value: "screening" as string | null,
    description: "Can independently screen papers — own decisions only",
    sections: ["overview", "import", "records", "overlap", "screening", "prisma", "labels", "saturation"],
  },
  {
    label: "Up to Extraction",
    value: "extraction" as string | null,
    description: "Can extract and build own concept taxonomy — own extraction forms, own concept aggregate",
    sections: ["overview", "import", "records", "overlap", "screening", "prisma", "labels", "saturation", "extractions", "citations", "concepts"],
  },
  {
    label: "Full access",
    value: null as string | null,
    description: "Full analysis access: thematic, ontology, consensus, team",
    sections: null, // all sections
  },
];

// Must match the `section` keys in AppShell PROJECT_NAV
const SECTIONS = [
  { key: "overview",     label: "Overview"        },
  { key: "import",       label: "Import"          },
  { key: "records",      label: "Records"         },
  { key: "overlap",      label: "Overlap"         },
  { key: "screening",    label: "Screening"       },
  { key: "extractions",  label: "Extractions"     },
  { key: "prisma",       label: "PRISMA"          },
  { key: "citations",    label: "Citation Search" },
  { key: "labels",       label: "Labels"          },
  { key: "concepts",     label: "Concepts"        },
  { key: "thematic",     label: "Thematic"        },
  { key: "ontology",     label: "Ontology"        },
  { key: "llm_screening",label: "LLM Screening"   },
  { key: "team",         label: "Team"            },
  { key: "consensus",    label: "Consensus"       },
];

// ── Small components ─────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  return (
    <span style={{
      background: ROLE_COLORS[role] || "#6b7280",
      color: "#fff",
      borderRadius: 4,
      padding: "2px 8px",
      fontSize: 12,
      fontWeight: 600,
    }}>
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

// ── Permissions modal ────────────────────────────────────────────────────────

function PermissionsModal({
  member,
  projectId,
  onClose,
}: {
  member: TeamMember;
  projectId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  // ── Two independent states ──────────────────────────────────────────────────
  // 1. Results visibility — which stage of data this reviewer can access
  const [dataStage, setDataStage] = useState<string | null>(
    member.permissions?.data_stage ?? null
  );

  // 2. Module availability — which nav sections appear in their sidebar
  const [selectedSections, setSelectedSections] = useState<Set<string>>(
    member.permissions?.allowed_sections
      ? new Set(member.permissions.allowed_sections)
      : new Set(SECTIONS.map(s => s.key))
  );

  const allSectionsSelected = selectedSections.size === SECTIONS.length;

  const mut = useMutation({
    mutationFn: ({ sections, stage }: { sections: string[] | null; stage: string | null }) =>
      teamApi.updateMemberPermissions(projectId, member.user_id, sections, stage),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members", projectId] });
      onClose();
    },
  });

  function toggleSection(key: string) {
    setSelectedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function save() {
    const sections = allSectionsSelected ? null : [...selectedSections];
    mut.mutate({ sections, stage: dataStage });
  }

  const DIVIDER: React.CSSProperties = {
    margin: "1rem 0 0.75rem",
    borderTop: "1px solid var(--border)",
    paddingTop: "1rem",
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 480 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Shield size={16} color="var(--brand)" />
            <h3 style={{ margin: 0, fontSize: "1rem" }}>
              Section access — {member.name || member.email}
            </h3>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ padding: "1rem 1.25rem" }}>

          {/* ── Stage presets ─────────────────────────────────────────────── */}
          <p style={{ margin: "0 0 0.25rem", fontSize: "0.82rem", fontWeight: 600, color: "#374151" }}>
            Access stage
          </p>
          <p style={{ margin: "0 0 0.6rem", fontSize: "0.78rem", color: "#475569" }}>
            Sets what data this reviewer can access and which modules are shown by default.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {STAGE_PRESETS.map((preset) => {
              const isActive = dataStage === preset.value;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setDataStage(preset.value);
                    setSelectedSections(
                      preset.sections
                        ? new Set(preset.sections)
                        : new Set(SECTIONS.map(s => s.key))
                    );
                  }}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "0.5rem 0.75rem", borderRadius: 7, textAlign: "left", cursor: "pointer",
                    border: `1.5px solid ${isActive ? "var(--brand)" : "var(--border)"}`,
                    background: isActive ? "#eff6ff" : "var(--surface)",
                  }}
                >
                  <div style={{
                    width: 12, height: 12, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                    background: isActive ? "var(--brand)" : "#d1d5db",
                  }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.82rem", color: isActive ? "#3730a3" : "var(--text)" }}>
                      {preset.label}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 1 }}>
                      {preset.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Fine-tune modules (checkboxes) ────────────────────────────── */}
          <div style={DIVIDER}>
            <p style={{ margin: "0 0 0.25rem", fontSize: "0.82rem", fontWeight: 600, color: "#374151" }}>
              Fine-tune modules
            </p>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.78rem", color: "#475569" }}>
              Adjust which specific sections appear in the sidebar (optional override).
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem 1.5rem", marginBottom: "0.75rem" }}>
            {SECTIONS.map(s => (
              <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selectedSections.has(s.key)}
                  onChange={() => toggleSection(s.key)}
                  style={{ width: 14, height: 14, accentColor: "var(--brand)" }}
                />
                {s.label}
              </label>
            ))}
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.82rem", cursor: "pointer", color: "#475569" }}>
            <input
              type="checkbox"
              checked={allSectionsSelected}
              onChange={() =>
                setSelectedSections(
                  allSectionsSelected ? new Set() : new Set(SECTIONS.map(s => s.key))
                )
              }
              style={{ width: 14, height: 14, accentColor: "var(--brand)" }}
            />
            Select all
          </label>

          {mut.isError && (
            <p style={{ color: "#dc2626", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
              {(mut.error as any)?.response?.data?.detail || "Failed to save permissions"}
            </p>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 1.25rem", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            disabled={mut.isPending || selectedSections.size === 0}
            onClick={save}
          >
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Assign papers modal ──────────────────────────────────────────────────────

function AssignPapersModal({
  member,
  projectId,
  onClose,
}: {
  member: TeamMember;
  projectId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  // Use all project records (not just FT-included ones) so admins can assign
  // papers even before screening is complete, and sub-project records always appear.
  const { data: recordsPage, isLoading } = useQuery({
    queryKey: ["project-records-all", projectId],
    queryFn: () => recordsApi.list(projectId, { per_page: 5000 }).then(r => r.data),
    staleTime: 30_000,
  });
  const papers: RecordItem[] = recordsPage?.records ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return papers;
    const q = search.toLowerCase();
    return papers.filter(p =>
      (p.title ?? "").toLowerCase().includes(q) ||
      (p.authors ?? []).join(" ").toLowerCase().includes(q) ||
      String(p.year ?? "").includes(q)
    );
  }, [papers, search]);

  // Initial selection: currently assigned record_ids
  const currentIds = useMemo<Set<string>>(() => {
    const ids = member.permissions?.record_ids;
    return ids ? new Set(ids) : new Set();
  }, [member.permissions]);

  const [selected, setSelected] = useState<Set<string>>(currentIds);

  function getPaperId(p: RecordItem) {
    return p.id;
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() { setSelected(new Set(filtered.map(getPaperId))); }
  function clearAll()  { setSelected(new Set()); }

  const mut = useMutation({
    mutationFn: (ids: string[] | null) =>
      teamApi.updateMemberRecordFilter(projectId, member.user_id, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members", projectId] });
      onClose();
    },
  });

  function save() {
    // Empty selection → clear filter (full access to all records)
    mut.mutate(selected.size === 0 ? null : [...selected]);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 620, maxHeight: "80vh", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BookMarked size={16} color="var(--brand)" />
            <h3 style={{ margin: 0, fontSize: "1rem" }}>
              Assign papers — {member.name || member.email}
            </h3>
          </div>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div style={{ padding: "0.75rem 1.25rem", borderBottom: "1px solid var(--border)" }}>
          <p style={{ margin: "0 0 0.6rem", fontSize: "0.82rem", color: "#475569" }}>
            Select the papers this reviewer can access in their screening queue.
            Leave empty to give full access to all records.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter by title, author, year…"
              style={{ flex: 1, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}
            />
            <button className="btn-ghost btn-sm" onClick={selectAll}>All</button>
            <button className="btn-ghost btn-sm" onClick={clearAll}>None</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
            {selected.size} of {papers.length} selected
            {selected.size === 0 && " (full access — no filter)"}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem 1.25rem" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>
              {papers.length === 0
                ? "No records found in this project yet."
                : "No papers match your search."}
            </div>
          ) : (
            filtered.map(p => {
              const id = getPaperId(p);
              const checked = selected.has(id);
              return (
                <label
                  key={id}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "8px 4px", cursor: "pointer", borderRadius: 4,
                    background: checked ? "#eef2ff" : "transparent",
                    borderBottom: "1px solid #f1f5f9",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    style={{ width: 14, height: 14, marginTop: 2, accentColor: "var(--brand)", flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#1e293b" }}>
                      {p.title ?? "(untitled)"}
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                      {[
                        p.authors?.slice(0, 3).join(", "),
                        p.year,
                        p.sources?.join(" · "),
                      ].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>

        {mut.isError && (
          <div style={{ padding: "0.5rem 1.25rem", color: "#dc2626", fontSize: "0.8rem" }}>
            {(mut.error as any)?.response?.data?.detail || "Failed to save assignment"}
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 1.25rem", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            disabled={mut.isPending}
            onClick={save}
          >
            {mut.isPending ? "Saving…" : "Save assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("reviewer");
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [acceptToken, setAcceptToken] = useState("");
  const [statsTab, setStatsTab] = useState<"team" | "reliability">("team");
  const [reliabilityStage, setReliabilityStage] = useState<"" | "TA" | "FT">("");
  const [permsMember, setPermsMember] = useState<TeamMember | null>(null);
  const [assignMember, setAssignMember] = useState<TeamMember | null>(null);

  const { data: myRole } = useQuery({
    queryKey: ["team-me", projectId],
    queryFn: () => teamApi.getMyRole(projectId!).then(r => r.data),
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ["team-members", projectId],
    queryFn: () => teamApi.listMembers(projectId!).then(r => r.data),
  });

  const { data: invitations = [] } = useQuery({
    queryKey: ["team-invitations", projectId],
    queryFn: () => teamApi.listInvitations(projectId!).then(r => r.data),
    enabled: myRole?.role === "owner" || myRole?.role === "admin",
  });

  const { data: teamStats = [] } = useQuery({
    queryKey: ["consensus-stats", projectId],
    queryFn: () => consensusApi.getTeamStats(projectId!).then(r => r.data),
  });

  const { data: reliability } = useQuery({
    queryKey: ["consensus-reliability", projectId, reliabilityStage],
    queryFn: () =>
      consensusApi.getReliability(projectId!, reliabilityStage || undefined).then(r => r.data),
  });

  const inviteMut = useMutation({
    mutationFn: () => teamApi.invite(projectId!, inviteEmail, inviteRole),
    onSuccess: (res) => {
      setInviteResult(res.data);
      setInviteEmail("");
      if (res.data.added_directly) {
        qc.invalidateQueries({ queryKey: ["team-members", projectId] });
      } else {
        qc.invalidateQueries({ queryKey: ["team-invitations", projectId] });
      }
    },
  });

  const revokeMut = useMutation({
    mutationFn: (invId: string) => teamApi.revokeInvitation(projectId!, invId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-invitations", projectId] }),
    onError: (e: unknown) => alert("Failed to revoke invitation: " + (e as { message?: string })?.message),
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => teamApi.removeMember(projectId!, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members", projectId] }),
    onError: (e: unknown) => alert("Failed to remove member: " + (e as { message?: string })?.message),
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

  function resetInviteForm() {
    setInviteResult(null);
    setShowInviteForm(false);
  }

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

      {/* ── Members table ──────────────────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Users size={16} /> Members ({members.length})
          </div>
          {isAdmin && (
            <button
              className="btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", fontSize: 13 }}
              onClick={() => { setShowInviteForm(v => !v); setInviteResult(null); }}
            >
              <UserPlus size={14} /> Add member
            </button>
          )}
        </div>

        {/* ── Invite form ── */}
        {showInviteForm && (
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "#f8f9fb" }}>
            {inviteResult ? (
              // Result feedback
              inviteResult.added_directly ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Check size={16} color="#059669" />
                  <span style={{ fontSize: 13, color: "#166534" }}>
                    <strong>{inviteResult.name || inviteResult.email}</strong> added as{" "}
                    <strong>{inviteResult.role}</strong>.
                  </span>
                  <button
                    className="btn-ghost btn-sm"
                    style={{ marginLeft: "auto" }}
                    onClick={resetInviteForm}
                  >
                    Done
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => setInviteResult(null)}
                  >
                    Add another
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <Check size={16} color="#059669" />
                    <span style={{ fontSize: 13, color: "#166534" }}>
                      Invitation created for <strong>{inviteResult.email}</strong> — no account found yet.
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)" }}>Share this link:</span>
                    <code style={{ background: "#e2e8f0", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>
                      {`${window.location.origin}/accept-invite?token=${inviteResult.token}`}
                    </code>
                    <CopyButton text={`${window.location.origin}/accept-invite?token=${inviteResult.token}`} />
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button className="btn-ghost btn-sm" onClick={resetInviteForm}>Done</button>
                    <button className="btn-secondary btn-sm" onClick={() => setInviteResult(null)}>Add another</button>
                  </div>
                </div>
              )
            ) : (
              // Invite form inputs
              <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Email</label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={e => setInviteEmail(e.target.value)}
                      placeholder="colleague@institution.edu"
                      style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, width: 240 }}
                      onKeyDown={e => e.key === "Enter" && inviteEmail && inviteMut.mutate()}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Role</label>
                    <select
                      value={inviteRole}
                      onChange={e => setInviteRole(e.target.value)}
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
                    {inviteMut.isPending ? "Adding…" : "Add"}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={resetInviteForm}>Cancel</button>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
                  If the email has an account, they'll be added immediately. Otherwise an invite link is created.
                </p>
                {inviteMut.isError && (
                  <p style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
                    {(inviteMut.error as any)?.response?.data?.detail || "Failed to add member"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {membersLoading ? (
          <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>Loading…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8f9fb" }}>
                {["Name", "Email", "Role", "Access", "Papers", ""].map(h => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m: TeamMember) => {
                const restricted = !m.is_owner && m.permissions?.allowed_sections != null;
                return (
                  <tr key={m.user_id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 16px", fontSize: 14, fontWeight: 500 }}>{m.name}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-muted)" }}>{m.email}</td>
                    <td style={{ padding: "10px 16px" }}>
                      {isAdmin && !m.is_owner ? (
                        <select
                          value={m.role}
                          onChange={e => roleMut.mutate({ userId: m.user_id, role: e.target.value })}
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
                    <td style={{ padding: "10px 16px" }}>
                      {m.is_owner ? (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Full access</span>
                      ) : isAdmin ? (
                        <button
                          onClick={() => setPermsMember(m)}
                          style={{
                            display: "flex", alignItems: "center", gap: 4,
                            background: restricted ? "#fef3c7" : "#f3f4f6",
                            border: `1px solid ${restricted ? "#fbbf24" : "var(--border)"}`,
                            borderRadius: 4, padding: "3px 8px", fontSize: 11, cursor: "pointer",
                            color: restricted ? "#92400e" : "var(--text-muted)",
                          }}
                          title="Edit section access"
                        >
                          <Shield size={11} />
                          {restricted
                            ? `${m.permissions!.allowed_sections!.length} sections`
                            : "Full access"}
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {restricted ? `${m.permissions!.allowed_sections!.length} sections` : "Full access"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      {m.is_owner ? (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>—</span>
                      ) : isAdmin ? (
                        <button
                          onClick={() => setAssignMember(m)}
                          style={{
                            display: "flex", alignItems: "center", gap: 4,
                            background: m.permissions?.record_ids ? "#eff6ff" : "#f3f4f6",
                            border: `1px solid ${m.permissions?.record_ids ? "#93c5fd" : "var(--border)"}`,
                            borderRadius: 4, padding: "3px 8px", fontSize: 11, cursor: "pointer",
                            color: m.permissions?.record_ids ? "#1d4ed8" : "var(--text-muted)",
                          }}
                          title="Assign specific papers"
                        >
                          <BookMarked size={11} />
                          {m.permissions?.record_ids
                            ? `${m.permissions.record_ids.length} paper${m.permissions.record_ids.length !== 1 ? "s" : ""}`
                            : "All papers"}
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {m.permissions?.record_ids
                            ? `${m.permissions.record_ids.length} assigned`
                            : "All papers"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      {!m.is_owner && (isAdmin || m.user_id === myRole?.user_id) && (
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
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Pending invitations ──────────────────────────────────────────── */}
      {isAdmin && invitations.length > 0 && (
        <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 14 }}>
            Pending Invitations
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8f9fb" }}>
                {["Email", "Role", "Status", "Invite Link", ""].map(h => (
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

      {/* ── Accept invite panel ──────────────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24, padding: "16px 18px" }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Accept an Invitation</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={acceptToken}
            onChange={e => setAcceptToken(e.target.value)}
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

      {/* ── Stats & Reliability tabs ─────────────────────────────────────── */}
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {[
            { key: "team", label: "Screening Progress", icon: <BarChart2 size={14} /> },
            { key: "reliability", label: "Inter-rater Reliability", icon: <Shield size={14} /> },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatsTab(tab.key as any)}
              style={{
                padding: "12px 20px", border: "none",
                borderBottom: statsTab === tab.key ? "2px solid var(--brand)" : "2px solid transparent",
                background: "none",
                color: statsTab === tab.key ? "var(--brand)" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: statsTab === tab.key ? 600 : 400,
                fontSize: 13,
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {statsTab === "team" && (
          <div>
            {teamStats.length === 0 ? (
              <div style={{ padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                No screening activity yet.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8f9fb" }}>
                    {["Reviewer", "TA Screened", "TA Included", "TA Excluded", "FT Screened", "FT Included", "FT Excluded", "Extractions"].map(h => (
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
              {(["", "TA", "FT"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setReliabilityStage(s)}
                  style={{
                    padding: "4px 12px", borderRadius: 16, border: "1px solid var(--border)",
                    background: reliabilityStage === s ? "var(--brand)" : "none",
                    color: reliabilityStage === s ? "#fff" : "var(--text)",
                    fontSize: 12, cursor: "pointer",
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
                      {["Reviewer A", "Reviewer B", "Items Both Screened", "Agreement", "Cohen's κ", "Interpretation"].map(h => (
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

      {/* ── Permissions modal ────────────────────────────────────────────── */}
      {permsMember && (
        <PermissionsModal
          member={permsMember}
          projectId={projectId!}
          onClose={() => setPermsMember(null)}
        />
      )}

      {/* ── Assign papers modal ──────────────────────────────────────────── */}
      {assignMember && (
        <AssignPapersModal
          member={assignMember}
          projectId={projectId!}
          onClose={() => setAssignMember(null)}
        />
      )}
    </div>
  );
}
