/**
 * AppShell — persistent sidebar + main content area.
 *
 * Wraps every authenticated page. When a project_id is present in the URL,
 * renders the project-specific nav; otherwise renders a minimal top nav.
 */
import { useParams, useLocation, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Upload, BookOpen, GitMerge, CheckSquare,
  FlaskConical, Tag, Network, Layers, LogOut, FolderOpen, ChevronLeft,
} from "lucide-react";
import { projectsApi, clearToken } from "../api/client";

// ── Nav items for project context ─────────────────────────────────────────

const PROJECT_NAV = [
  { path: "",            icon: LayoutDashboard, label: "Overview"    },
  { path: "/import",     icon: Upload,          label: "Import"      },
  { path: "/records",    icon: BookOpen,         label: "Records"     },
  { path: "/overlap",    icon: GitMerge,         label: "Overlap"     },
  { path: "/screen",     icon: CheckSquare,      label: "Screening"   },
  { path: "/extractions",icon: FlaskConical,     label: "Extractions" },
  { path: "/labels",     icon: Tag,              label: "Labels"      },
  { path: "/ontology",   icon: Network,          label: "Taxonomy"    },
  { path: "/thematic",   icon: Layers,           label: "Thematic"    },
];

// ── Component ─────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id?: string }>();
  const location = useLocation();

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.getById(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  function handleSignOut() {
    clearToken();
    window.location.href = "/login";
  }

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
            {/* Back + project name */}
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

            {/* Project nav */}
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
          /* Projects list nav */
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

        {/* Sign-out */}
        <div className="sidebar-footer">
          <button className="sidebar-signout" onClick={handleSignOut}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="shell-main">
        {children}
      </main>
    </div>
  );
}
