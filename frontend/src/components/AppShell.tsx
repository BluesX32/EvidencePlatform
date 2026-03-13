/**
 * AppShell — persistent sidebar + main content area.
 *
 * User profile lives at the bottom-left of the sidebar (Linear/Notion style).
 * Click the profile card to open a popover with:
 *   - inline name editing
 *   - change password
 *   - tutorial
 *   - keyboard shortcuts
 *   - sign out
 */
import { useState, useRef, useEffect } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Upload, BookOpen, GitMerge, CheckSquare,
  FlaskConical, Tag, Network, GitBranch, Bot, LogOut, FolderOpen, ChevronLeft,
  Users, Scale, HelpCircle, KeyRound, ChevronsUpDown, Pencil, Check, X, Keyboard,
} from "lucide-react";
import { projectsApi, authApi, clearToken } from "../api/client";

// ── Nav items ─────────────────────────────────────────────────────────────

const PROJECT_NAV = [
  { path: "",             icon: LayoutDashboard, label: "Overview"     },
  { path: "/import",      icon: Upload,          label: "Import"       },
  { path: "/records",     icon: BookOpen,        label: "Records"      },
  { path: "/overlap",     icon: GitMerge,        label: "Overlap"      },
  { path: "/screen",      icon: CheckSquare,     label: "Screening"    },
  { path: "/extractions", icon: FlaskConical,    label: "Extractions"  },
  { path: "/labels",      icon: Tag,             label: "Labels"       },
  { path: "/thematic",    icon: GitBranch,       label: "Taxonomy"     },
  { path: "/ontology",    icon: Network,         label: "Ontology"     },
  { path: "/llm-screening", icon: Bot,           label: "LLM Screening"},
  { path: "/team",        icon: Users,           label: "Team"         },
  { path: "/consensus",   icon: Scale,           label: "Consensus"    },
];

// ── Keyboard shortcuts modal ──────────────────────────────────────────────

const SHORTCUTS = [
  { keys: ["⌘", "↵"],  action: "Save note in PDF viewer"      },
  { keys: ["←", "→"],  action: "Previous / next screening item" },
  { keys: ["I"],        action: "Include (TA / FT screen)"     },
  { keys: ["E"],        action: "Exclude (TA / FT screen)"     },
  { keys: ["U"],        action: "Uncertain / skip"             },
];

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: "1rem" }}>Keyboard shortcuts</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "0.75rem 1.25rem 1.25rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {SHORTCUTS.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.84rem" }}>
              <span style={{ color: "#475569" }}>{s.action}</span>
              <span style={{ display: "flex", gap: "0.2rem" }}>
                {s.keys.map((k, j) => (
                  <kbd key={j} style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    minWidth: 24, padding: "0.1rem 0.4rem", borderRadius: "0.25rem",
                    border: "1px solid #cbd5e1", background: "#f8fafc",
                    fontSize: "0.76rem", fontFamily: "monospace", color: "#334155",
                    boxShadow: "0 1px 0 #cbd5e1",
                  }}>{k}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Change-password modal ─────────────────────────────────────────────────

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localErr, setLocalErr] = useState("");
  const [done, setDone] = useState(false);

  const mut = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => setDone(true),
    onError: (err: any) => setLocalErr(err?.response?.data?.detail ?? "Password change failed"),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalErr("");
    if (next.length < 8) { setLocalErr("New password must be at least 8 characters"); return; }
    if (next !== confirm) { setLocalErr("Passwords do not match"); return; }
    mut.mutate();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: "1rem" }}>Change password</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {done ? (
          <div style={{ padding: "1.5rem 1.25rem", textAlign: "center" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>✅</div>
            <p style={{ margin: 0, fontSize: "0.88rem", color: "#16a34a", fontWeight: 600 }}>Password updated successfully.</p>
            <button className="btn-primary btn-sm" style={{ marginTop: "1rem" }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1.1rem 1.25rem 1.25rem" }}>
            <div>
              <label style={labelSt}>Current password</label>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoFocus style={inputSt} placeholder="••••••••" />
            </div>
            <div>
              <label style={labelSt}>New password</label>
              <input type="password" value={next} onChange={e => setNext(e.target.value)} required style={inputSt} placeholder="At least 8 characters" />
            </div>
            <div>
              <label style={labelSt}>Confirm new password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required style={inputSt} placeholder="••••••••" />
            </div>
            {localErr && <p style={{ margin: 0, fontSize: "0.8rem", color: "#dc2626" }}>{localErr}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.25rem" }}>
              <button type="button" className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary btn-sm" disabled={mut.isPending}>
                {mut.isPending ? "Saving…" : "Update password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const labelSt: React.CSSProperties = { display: "block", fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "0.3rem" };
const inputSt: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: "0.375rem", fontSize: "0.88rem", outline: "none" };

// ── Sidebar profile card + popover ────────────────────────────────────────

function SidebarProfile() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: profile } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => authApi.me().then(r => r.data),
    staleTime: 5 * 60_000,
  });

  const nameMut = useMutation({
    mutationFn: (name: string) => authApi.updateProfile(name),
    onSuccess: (res) => {
      qc.setQueryData(["auth-me"], res.data);
      setEditingName(false);
    },
  });

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const initials = profile?.name
    ? profile.name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase()
    : "?";

  function startEditName() {
    setNameDraft(profile?.name ?? "");
    setEditingName(true);
  }

  function saveName() {
    if (nameDraft.trim()) nameMut.mutate(nameDraft.trim());
  }

  function handleSignOut() {
    clearToken();
    window.location.href = "/login";
  }

  function handleTutorial() {
    setOpen(false);
    localStorage.removeItem("ep_tour_done");
    window.location.href = "/projects";
  }

  const MI = (icon: React.ReactNode, label: string, onClick: () => void, color?: string) => (
    <button
      onClick={() => { onClick(); setOpen(false); }}
      style={{ ...miBtnStyle, color: color ?? "#cbd5e1" }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ opacity: 0.7, display: "flex" }}>{icon}</span>
      {label}
    </button>
  );

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Popover — rises above the profile card */}
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0,
          background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "0.5rem", boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
          overflow: "hidden", zIndex: 200,
        }}>
          {/* Profile header with name edit */}
          <div style={{ padding: "0.85rem 0.9rem 0.7rem", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
              <div style={avatarStyle}>{initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingName ? (
                  <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={e => setNameDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                      style={{ flex: 1, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "0.25rem", color: "#f1f5f9", fontSize: "0.82rem", padding: "0.2rem 0.4rem", outline: "none" }}
                    />
                    <button onClick={saveName} style={iconActStyle} title="Save"><Check size={13} /></button>
                    <button onClick={() => setEditingName(false)} style={iconActStyle} title="Cancel"><X size={13} /></button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <span style={{ fontSize: "0.86rem", fontWeight: 600, color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {profile?.name}
                    </span>
                    <button onClick={startEditName} style={iconActStyle} title="Edit name"><Pencil size={11} /></button>
                  </div>
                )}
                <div style={{ fontSize: "0.73rem", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "0.1rem" }}>
                  {profile?.email}
                </div>
              </div>
            </div>
          </div>

          {/* Account actions */}
          <div style={{ padding: "0.3rem 0" }}>
            <div style={sectionLabel}>Account</div>
            {MI(<KeyRound size={14} />, "Change password", () => { setShowPw(true); })}
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "0.3rem 0" }}>
            <div style={sectionLabel}>Help</div>
            {MI(<HelpCircle size={14} />, "Tutorial", handleTutorial)}
            {MI(<Keyboard size={14} />, "Keyboard shortcuts", () => { setShowShortcuts(true); })}
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "0.3rem 0 0.4rem" }}>
            {MI(<LogOut size={14} />, "Sign out", handleSignOut, "#f87171")}
          </div>
        </div>
      )}

      {/* Profile card button */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: "0.6rem",
          padding: "0.6rem 0.75rem", background: "none", border: "none",
          borderTop: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
          transition: "background 0.13s",
          textAlign: "left",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
        onMouseLeave={e => (e.currentTarget.style.background = "none")}
      >
        <div style={avatarStyle}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile?.name ?? "Account"}
          </div>
          <div style={{ fontSize: "0.71rem", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile?.email}
          </div>
        </div>
        <ChevronsUpDown size={13} style={{ color: "#475569", flexShrink: 0 }} />
      </button>

      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}

const avatarStyle: React.CSSProperties = {
  width: 30, height: 30, borderRadius: "50%",
  background: "var(--brand, #4f46e5)", color: "#fff",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: "0.72rem", fontWeight: 700, flexShrink: 0,
};

const miBtnStyle: React.CSSProperties = {
  width: "100%", display: "flex", alignItems: "center", gap: "0.6rem",
  padding: "0.45rem 0.9rem", background: "transparent", border: "none",
  fontSize: "0.82rem", cursor: "pointer", textAlign: "left", transition: "background 0.1s",
};

const iconActStyle: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  color: "#64748b", display: "flex", alignItems: "center", padding: "0.1rem",
  borderRadius: "0.2rem",
};

const sectionLabel: React.CSSProperties = {
  fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.08em",
  textTransform: "uppercase", color: "#475569", padding: "0.2rem 0.9rem 0.15rem",
};

// ── Component ─────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id?: string }>();
  const location = useLocation();

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then(r => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <Link to="/projects">
            <span className="sidebar-logo-mark">E</span>
            EvidencePlatform
          </Link>
        </div>

        {projectId ? (
          <>
            <div className="sidebar-section">
              <Link to="/projects" className="sidebar-back">
                <ChevronLeft size={14} />
                All projects
              </Link>
              <div className="sidebar-project-name" title={project?.name}>
                <FolderOpen size={12} style={{ display: "inline", marginRight: 4, opacity: .7 }} />
                {project?.name ?? "Project"}
              </div>
            </div>

            <div className="sidebar-divider" />

            <nav className="sidebar-nav">
              {PROJECT_NAV.map(({ path, icon: Icon, label }) => {
                const fullPath = `/projects/${projectId}${path}`;
                const isActive =
                  path === ""
                    ? location.pathname === `/projects/${projectId}`
                    : location.pathname.startsWith(fullPath);
                return (
                  <Link
                    key={path}
                    to={fullPath}
                    className={`sidebar-link${isActive ? " active" : ""}`}
                  >
                    <span className="sidebar-icon"><Icon size={15} /></span>
                    {label}
                  </Link>
                );
              })}
            </nav>
          </>
        ) : (
          <nav className="sidebar-nav" style={{ paddingTop: ".75rem" }}>
            <Link
              to="/projects"
              className={`sidebar-link${location.pathname === "/projects" ? " active" : ""}`}
            >
              <span className="sidebar-icon"><FolderOpen size={15} /></span>
              Projects
            </Link>
          </nav>
        )}

        {/* Profile card — always at bottom */}
        <div style={{ marginTop: "auto" }}>
          <SidebarProfile />
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="shell-main">
        {children}
      </main>
    </div>
  );
}
