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
  FlaskConical, Tag, Network, Bot, LogOut, FolderOpen, ChevronLeft,
  Users, Scale, HelpCircle, KeyRound, ChevronsUpDown, Pencil, Check, X, Keyboard,
  Menu, PanelLeftClose, Search, SearchCode, Layers, BarChart2, GripVertical, Cloud, ShieldCheck, Settings, Hash, Eye, FileText, Cpu,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { projectsApi, authApi, teamApi, clearToken, type UserProfile } from "../api/client";
import { useReviewerView } from "../context/ReviewerViewContext";
import OnboardingTour from "./OnboardingTour";
import CommandPalette from "./CommandPalette";

// ── Nav items ─────────────────────────────────────────────────────────────
// Grouped by workflow stage so the sidebar mirrors the evidence synthesis
// pipeline: collect → screen → analyze → synthesize.

const PROJECT_NAV = [
  { path: "",                   icon: LayoutDashboard, label: "Overview",        section: "overview",      group: null          },
  { path: "/import",            icon: Upload,          label: "Import",          section: "import",        group: "Collect"     },
  { path: "/search",            icon: Search,          label: "PubMed Search",   section: "search",        group: "Collect"     },
  { path: "/records",           icon: BookOpen,        label: "Records",         section: "records",       group: "Collect"     },
  { path: "/overlap",           icon: GitMerge,        label: "Overlap",         section: "overlap",       group: "Collect"     },
  { path: "/screen",            icon: CheckSquare,     label: "Screening",       section: "screening",     group: "Screen"      },
  { path: "/llm-screening",     icon: Bot,             label: "LLM Screening",   section: "llm_screening", group: "Screen"      },
  { path: "/consensus",         icon: Scale,           label: "Consensus",       section: "consensus",     group: "Screen"      },
  { path: "/prisma",            icon: BarChart2,       label: "PRISMA",          section: "prisma",        group: "Screen"      },
  { path: "/extractions",       icon: FlaskConical,    label: "Extractions",     section: "extractions",   group: "Analyze"     },
  { path: "/labels",            icon: Tag,             label: "Labels",          section: "labels",        group: "Analyze"     },
  { path: "/concept-taxonomy",  icon: Layers,          label: "Concepts",        section: "concepts",      group: "Analyze"     },
  { path: "/thematic",          icon: Hash,            label: "Thematic",        section: "thematic",      group: "Analyze"     },
  { path: "/ontology",          icon: Network,         label: "Ontology",        section: "ontology",      group: "Analyze"     },
  { path: "/report",            icon: FileText,        label: "Synthesis",       section: "report",        group: "Synthesize"  },
  { path: "/citations",         icon: SearchCode,      label: "Citation Search", section: "citations",     group: "Synthesize"  },
  { path: "/ai-pilot",          icon: Cpu,             label: "AI Pilot",        section: "ai_pilot",      group: "Project"     },
  { path: "/team",              icon: Users,           label: "Team",            section: "team",          group: "Project"     },
];

const NAV_GROUP_ORDER: (string | null)[] = [null, "Collect", "Screen", "Analyze", "Synthesize", "Project"];

const NAV_PATHS = PROJECT_NAV.map(n => n.path);
const NAV_ORDER_KEY = "ep_nav_order";

function loadNavOrder(): string[] {
  try {
    const raw = localStorage.getItem(NAV_ORDER_KEY);
    const saved: string[] = JSON.parse(raw || "null");
    if (Array.isArray(saved)) {
      // Keep saved order, append any new items not yet in it
      const known = saved.filter(p => NAV_PATHS.includes(p));
      const added = NAV_PATHS.filter(p => !known.includes(p));
      return [...known, ...added];
    }
  } catch { /* ignore */ }
  return NAV_PATHS;
}

// ── Keyboard shortcuts modal ──────────────────────────────────────────────

const SHORTCUTS = [
  { keys: ["⌘", "K"],  action: "Open command palette"         },
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


const labelSt: React.CSSProperties = { display: "block", fontSize: "0.78rem", fontWeight: 600, color: "#475569", marginBottom: "0.3rem" };
const inputSt: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: "0.375rem", fontSize: "0.88rem", outline: "none" };

// ── API Keys Modal ────────────────────────────────────────────────────────

function ApiKeysModal({ profile, onClose, onSaved }: { profile: UserProfile | null; onClose: () => void; onSaved: (p: UserProfile) => void }) {
  const [anthropic, setAnthropic] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [odStatus, setOdStatus] = useState<"idle" | "connecting" | "disconnecting" | "error">("idle");

  const mut = useMutation({
    mutationFn: () => authApi.updateApiKeys({
      ...(anthropic !== "" ? { anthropic } : {}),
      ...(openrouter !== "" ? { openrouter } : {}),
    }),
    onSuccess: (res) => {
      onSaved(res.data);
      setAnthropic("");
      setOpenrouter("");
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    },
    onError: () => setStatus("error"),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    mut.mutate();
  }

  function clearKey(type: "anthropic" | "openrouter") {
    authApi.updateApiKeys({ [type]: "" }).then(res => onSaved(res.data));
  }

  async function connectOneDrive() {
    setOdStatus("connecting");
    try {
      const res = await authApi.getOneDriveConnectUrl();
      // Open OAuth popup and listen for the redirect code via postMessage
      const popup = window.open(res.data.url, "onedrive_auth", "width=600,height=700");
      const handler = async (ev: MessageEvent) => {
        if (ev.data?.type !== "onedrive_code") return;
        window.removeEventListener("message", handler);
        popup?.close();
        try {
          const exRes = await authApi.exchangeOneDriveCode(ev.data.code as string);
          onSaved(exRes.data);
          setOdStatus("idle");
        } catch {
          setOdStatus("error");
        }
      };
      window.addEventListener("message", handler);
      // Fallback: clear connecting state if popup closed without sending code
      const interval = setInterval(() => {
        if (popup?.closed) { clearInterval(interval); window.removeEventListener("message", handler); setOdStatus("idle"); }
      }, 1000);
    } catch {
      setOdStatus("error");
    }
  }

  async function disconnectOneDrive() {
    setOdStatus("disconnecting");
    try {
      await authApi.disconnectOneDrive();
      const updated = await authApi.me();
      onSaved(updated.data);
    } catch { /* ignore */ }
    setOdStatus("idle");
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: "1rem" }}>API keys &amp; connections</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "1rem 1.25rem 1.25rem" }}>
          <p style={{ fontSize: "0.82rem", color: "#475569", margin: "0 0 1rem" }}>
            Keys are stored in your account and used automatically for LLM screening runs.
            They are never shared with other users.
          </p>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {/* Anthropic */}
            <div>
              <label style={labelSt}>Anthropic API key</label>
              {profile?.anthropic_key_hint ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                  <span style={{ fontSize: "0.82rem", fontFamily: "monospace", color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "0.25rem", padding: "0.2rem 0.5rem" }}>
                    {profile.anthropic_key_hint}
                  </span>
                  <button type="button" onClick={() => clearKey("anthropic")} style={{ fontSize: "0.75rem", color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Remove</button>
                </div>
              ) : (
                <p style={{ fontSize: "0.75rem", color: "#9aa0a6", margin: "0 0 0.4rem" }}>Not set</p>
              )}
              <input type="password" value={anthropic} onChange={e => setAnthropic(e.target.value)} style={inputSt} placeholder="sk-ant-…  (leave blank to keep current)" autoComplete="off" />
            </div>

            {/* OpenRouter */}
            <div>
              <label style={labelSt}>OpenRouter API key</label>
              {profile?.openrouter_key_hint ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                  <span style={{ fontSize: "0.82rem", fontFamily: "monospace", color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "0.25rem", padding: "0.2rem 0.5rem" }}>
                    {profile.openrouter_key_hint}
                  </span>
                  <button type="button" onClick={() => clearKey("openrouter")} style={{ fontSize: "0.75rem", color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Remove</button>
                </div>
              ) : (
                <p style={{ fontSize: "0.75rem", color: "#9aa0a6", margin: "0 0 0.4rem" }}>Not set</p>
              )}
              <input type="password" value={openrouter} onChange={e => setOpenrouter(e.target.value)} style={inputSt} placeholder="sk-or-…  (leave blank to keep current)" autoComplete="off" />
            </div>

            {status === "error" && <p style={{ margin: 0, fontSize: "0.8rem", color: "#dc2626" }}>Save failed — please try again</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.25rem" }}>
              <button type="button" className="btn-ghost btn-sm" onClick={onClose}>Close</button>
              <button type="submit" className="btn-primary btn-sm" disabled={status === "saving" || (!anthropic && !openrouter)}>
                {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : "Save keys"}
              </button>
            </div>
          </form>

          {/* OneDrive */}
          <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "1.25rem 0 1rem" }} />
          <div>
            <label style={labelSt}>Microsoft OneDrive</label>
            <p style={{ fontSize: "0.78rem", color: "#64748b", margin: "0 0 0.75rem" }}>
              Connect OneDrive so the LLM screener can access full-text PDFs stored in your drive.
            </p>
            {profile?.onedrive_connected ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem", color: "#16a34a" }}>
                  <Cloud size={14} /> Connected
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={odStatus === "disconnecting"}
                  onClick={disconnectOneDrive}
                  style={{ fontSize: "0.75rem", color: "#dc2626" }}
                >
                  {odStatus === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={odStatus === "connecting"}
                onClick={connectOneDrive}
                style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
              >
                <Cloud size={14} />
                {odStatus === "connecting" ? "Connecting…" : "Connect OneDrive"}
              </button>
            )}
            {odStatus === "error" && (
              <p style={{ margin: "0.4rem 0 0", fontSize: "0.78rem", color: "#dc2626" }}>
                OneDrive connection failed — please try again
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar profile card + popover ────────────────────────────────────────

function SidebarProfile() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
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
    // Reload the current page so the tour mounts with the correct sidebar visible.
    // (If the user is inside a project, the project nav items will be in the DOM
    //  and spotlight effects will work.)
    window.location.reload();
  }

  const MI = (icon: React.ReactNode, label: React.ReactNode, onClick: () => void, color?: string) => (
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
            {MI(<Settings size={14} />, "Account settings", () => { navigate("/settings"); })}
            {MI(<KeyRound size={14} />,
              <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                API keys
                {(profile?.anthropic_key_hint || profile?.openrouter_key_hint) && (
                  <span style={{ fontSize: "0.65rem", background: "#166534", color: "#bbf7d0", borderRadius: "0.25rem", padding: "0.05rem 0.3rem", fontWeight: 700 }}>set</span>
                )}
              </span>,
              () => { setShowApiKeys(true); }
            )}
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
        <div className="sidebar-profile-text" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile?.name ?? "Account"}
          </div>
          <div style={{ fontSize: "0.71rem", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile?.email}
          </div>
        </div>
        <ChevronsUpDown size={13} style={{ color: "#475569", flexShrink: 0 }} />
      </button>

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showApiKeys && <ApiKeysModal profile={profile ?? null} onClose={() => setShowApiKeys(false)} onSaved={(updated) => qc.setQueryData(["auth-me"], updated)} />}
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

// ── Global nav (non-project sidebar) ─────────────────────────────────────

function GlobalNav({ onNavigate }: { onNavigate: () => void }) {
  const location = useLocation();
  const { data: profile } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => authApi.me().then(r => r.data),
    staleTime: 5 * 60_000,
  });

  return (
    <nav className="sidebar-nav" style={{ paddingTop: ".75rem" }}>
      <Link
        to="/projects"
        className={`sidebar-link${location.pathname === "/projects" ? " active" : ""}`}
        onClick={onNavigate}
      >
        <span className="sidebar-icon"><FolderOpen size={15} /></span>
        <span className="sidebar-label">Projects</span>
      </Link>
      <Link
        to="/settings"
        className={`sidebar-link${location.pathname.startsWith("/settings") ? " active" : ""}`}
        onClick={onNavigate}
      >
        <span className="sidebar-icon"><Settings size={15} /></span>
        <span className="sidebar-label">Settings</span>
      </Link>
      {profile?.is_admin && (
        <Link
          to="/admin"
          className={`sidebar-link${location.pathname.startsWith("/admin") ? " active" : ""}`}
          onClick={onNavigate}
        >
          <span className="sidebar-icon"><ShieldCheck size={15} /></span>
          <span className="sidebar-label">Admin</span>
        </Link>
      )}
    </nav>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id?: string }>();
  const location = useLocation();
  const { reviewerView, exitReviewerView } = useReviewerView();

  // Auto-clear reviewer view when leaving this project
  const activeReviewerView =
    reviewerView && projectId && reviewerView.projectId === projectId
      ? reviewerView
      : null;

  // Onboarding tour — shown on first visit (or after "Tutorial" in profile menu)
  const [showTour, setShowTour] = useState(() => !localStorage.getItem("ep_tour_done"));

  // Command palette (⌘K / Ctrl+K)
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then(r => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: myRole } = useQuery({
    queryKey: ["team-me", projectId],
    queryFn: () => teamApi.getMyRole(projectId!).then(r => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // Sections the current user may see; null = all allowed (owners always get all)
  const allowedSections: Set<string> | null = (() => {
    if (!myRole || myRole.is_owner) return null;
    const perms = myRole.permissions;
    if (!perms || !perms.allowed_sections) return null;
    return new Set(perms.allowed_sections);
  })();

  // Responsive sidebar state
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  // Draggable nav order (persisted to localStorage) — reordering is
  // constrained to within a workflow group.
  const [navOrder, setNavOrder] = useState<string[]>(loadNavOrder);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const orderedNav = navOrder
    .map(p => PROJECT_NAV.find(n => n.path === p))
    .filter((n): n is (typeof PROJECT_NAV)[number] => !!n)
    .filter(n => !allowedSections || allowedSections.has(n.section));

  const navGroups = NAV_GROUP_ORDER
    .map(group => ({ group, items: orderedNav.filter(n => n.group === group) }))
    .filter(g => g.items.length > 0);

  function sameGroup(a: string, b: string) {
    return PROJECT_NAV.find(n => n.path === a)?.group === PROJECT_NAV.find(n => n.path === b)?.group;
  }

  function navDragStart(_e: React.DragEvent, path: string) {
    setDragPath(path);
  }
  function navDragOver(e: React.DragEvent, path: string) {
    e.preventDefault();
    if (dragPath !== null && dragPath !== path && sameGroup(dragPath, path)) setDragOverPath(path);
  }
  function navDrop(_e: React.DragEvent, path: string) {
    if (dragPath === null || dragPath === path || !sameGroup(dragPath, path)) return;
    const next = [...navOrder];
    const [moved] = next.splice(next.indexOf(dragPath), 1);
    next.splice(next.indexOf(path), 0, moved);
    setNavOrder(next);
    localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
    setDragPath(null);
    setDragOverPath(null);
  }
  function navDragEnd() {
    setDragPath(null);
    setDragOverPath(null);
  }

  useEffect(() => {
    function handleResize() {
      const w = window.innerWidth;
      if (w >= 1024) {
        setCollapsed(false);
        setMobileOpen(false);
      } else if (w >= 768) {
        setCollapsed(true);
        setMobileOpen(false);
      } else {
        setCollapsed(false); // on mobile, collapsed class not used; drawer controls visibility
        setMobileOpen(false);
      }
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  // Compute margin-left for shell-main
  const mainMarginLeft = isMobile
    ? "0"
    : collapsed
      ? "64px"
      : "220px";

  // Sidebar class names
  const sidebarClasses = [
    "sidebar",
    collapsed && !isMobile ? "sidebar--collapsed" : "",
    mobileOpen ? "sidebar--mobile-open" : "",
    isMobile ? "sidebar--mobile" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className={sidebarClasses}>
        {/* Logo */}
        <div className="sidebar-logo">
          <Link to="/projects">
            <span className="sidebar-logo-mark">E</span>
            <span className="sidebar-label">EvidencePlatform</span>
          </Link>
          {/* Collapse toggle — only shown on desktop (>= 768px) */}
          <button
            className="sidebar-logo-toggle"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>

        {projectId ? (
          <>
            <div className="sidebar-section">
              <Link to="/projects" className="sidebar-back">
                <ChevronLeft size={14} />
                <span className="sidebar-label">All projects</span>
              </Link>
              <div className="sidebar-project-name" title={project?.name}>
                <FolderOpen size={12} style={{ display: "inline", marginRight: 4, opacity: .7 }} />
                {project?.name ?? "Project"}
              </div>
            </div>

            {/* ── Reviewer mode panel ─────────────────────────────────── */}
            {activeReviewerView && (() => {
              const rv = activeReviewerView;
              const initials = rv.reviewerName
                .split(/[\s@.]+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase()).join("");
              return (
                <div style={{
                  margin: "0 8px 0", borderRadius: 8,
                  background: "linear-gradient(135deg, #78350f18, #92400e12)",
                  border: "1px solid #f59e0b44",
                  overflow: "hidden",
                }}>
                  {/* Header strip */}
                  <div style={{
                    background: "linear-gradient(90deg, #d97706, #f59e0b)",
                    padding: "5px 10px",
                    display: "flex", alignItems: "center", gap: 5,
                    fontSize: 10, fontWeight: 700, color: "#78350f",
                    letterSpacing: "0.07em", textTransform: "uppercase",
                  }}>
                    <Eye size={10} />
                    <span className="sidebar-label">Reviewer View</span>
                  </div>
                  {/* Reviewer identity */}
                  <div style={{ padding: "10px 10px 8px", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                      background: "linear-gradient(135deg, #d97706, #f59e0b)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#fff", fontWeight: 700, fontSize: 11,
                    }}>
                      {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="sidebar-label" style={{
                        fontSize: 12, fontWeight: 600, color: "#fbbf24",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {rv.reviewerName}
                      </div>
                      <div className="sidebar-label" style={{ fontSize: 10, color: "#92400e", marginTop: 1 }}>
                        read-only
                      </div>
                    </div>
                  </div>
                  {/* Action row */}
                  <div style={{ padding: "0 8px 8px", display: "flex", gap: 4 }}>
                    <Link
                      to={`/projects/${projectId}/reviewer/${rv.reviewerId}?name=${encodeURIComponent(rv.reviewerName)}`}
                      style={{
                        flex: 1, textAlign: "center", fontSize: 11, fontWeight: 600,
                        padding: "4px 0", borderRadius: 5, textDecoration: "none",
                        background: "rgba(251,191,36,0.15)", color: "#fbbf24",
                        border: "1px solid rgba(251,191,36,0.25)",
                      }}
                    >
                      Activity
                    </Link>
                    <button
                      onClick={exitReviewerView}
                      title="Exit reviewer view"
                      style={{
                        flex: 1, fontSize: 11, fontWeight: 600, cursor: "pointer",
                        padding: "4px 0", borderRadius: 5,
                        background: "rgba(239,68,68,0.12)", color: "#f87171",
                        border: "1px solid rgba(239,68,68,0.2)",
                      }}
                    >
                      ✕ Exit
                    </button>
                  </div>
                </div>
              );
            })()}

            <div className="sidebar-divider" />

            <nav className="sidebar-nav">
              {navGroups.map(({ group, items }) => (
                <div key={group ?? "main"} className="sidebar-group">
                  {group && <div className="sidebar-group-label">{group}</div>}
                  {items.map(({ path, icon: Icon, label, section }) => {
                    const basePath = `/projects/${projectId}${path}`;
                    let fullPath = basePath;
                    if (path === "/screen" && projectId) {
                      const saved = localStorage.getItem(`ep_screening_last_${projectId}`);
                      if (saved) fullPath = `${basePath}?${saved}`;
                    }
                    // In reviewer canvas mode, Extractions link carries the reviewer filter
                    if (path === "/extractions" && activeReviewerView) {
                      fullPath = `${basePath}?reviewerId=${activeReviewerView.reviewerId}&reviewerName=${encodeURIComponent(activeReviewerView.reviewerName)}`;
                    }
                    const isActive =
                      path === ""
                        ? location.pathname === `/projects/${projectId}`
                        : location.pathname.startsWith(basePath);
                    const isDragging = dragPath === path;
                    const isOver = dragOverPath === path;
                    return (
                      <div
                        key={path}
                        className={`sidebar-nav-item${isDragging ? " is-dragging" : ""}${isOver ? " is-drag-over" : ""}`}
                        draggable={!isMobile && !collapsed}
                        onDragStart={e => navDragStart(e, path)}
                        onDragOver={e => navDragOver(e, path)}
                        onDrop={e => navDrop(e, path)}
                        onDragEnd={navDragEnd}
                      >
                        <Link
                          to={fullPath}
                          className={`sidebar-link${isActive ? " active" : ""}`}
                          onClick={() => { if (isMobile) setMobileOpen(false); }}
                          data-tour={section}
                        >
                          <span className="drag-grip sidebar-label">
                            <GripVertical size={11} />
                          </span>
                          <span className="sidebar-icon"><Icon size={15} /></span>
                          <span className="sidebar-label">{label}</span>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              ))}
            </nav>
          </>
        ) : (
          <GlobalNav onNavigate={() => { if (isMobile) setMobileOpen(false); }} />
        )}

        {/* Profile card — always at bottom */}
        <div style={{ marginTop: "auto" }}>
          <SidebarProfile />
        </div>
      </aside>

      {/* Backdrop overlay for mobile drawer */}
      {mobileOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button
          className="icon-btn"
          onClick={() => setMobileOpen(v => !v)}
          aria-label="Open navigation"
          style={{ border: "none", background: "transparent" }}
        >
          <Menu size={20} />
        </button>
        <span className="mobile-topbar-title">
          {project?.name ?? "EvidencePlatform"}
        </span>
      </div>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="shell-main" style={{ marginLeft: mainMarginLeft }}>
        {children}
      </main>

      {/* ── Onboarding tour overlay ──────────────────────────────────────── */}
      {showTour && <OnboardingTour onDone={() => setShowTour(false)} />}

      {/* ── Command palette (⌘K) ─────────────────────────────────────────── */}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          projectId={projectId}
          navItems={orderedNav}
        />
      )}
    </div>
  );
}
