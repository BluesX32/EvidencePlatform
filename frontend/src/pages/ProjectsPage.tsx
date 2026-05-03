import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, BookOpen, Calendar, GitBranch } from "lucide-react";
import { projectsApi } from "../api/client";

export default function ProjectsPage() {
  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list().then((r) => r.data),
  });

  return (
    <div className="page">
      {/* Header */}
      <div className="projects-header">
        <div>
          <h1 style={{ marginBottom: ".2rem" }}>Projects</h1>
          <p className="muted" style={{ margin: 0 }}>
            Manage your systematic review projects
          </p>
        </div>
        <Link to="/projects/new" className="btn-primary btn-lg">
          <Plus size={18} /> New project
        </Link>
      </div>

      {/* States */}
      {isLoading && (
        <div style={{ display: "flex", gap: ".75rem", alignItems: "center", color: "var(--text-muted)", fontSize: ".9rem" }}>
          <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
          Loading projects…
        </div>
      )}
      {error && <p className="error">Failed to load projects. Please refresh.</p>}

      {projects?.length === 0 && (
        <div className="empty-state" style={{ padding: "5rem 1rem" }}>
          <div className="empty-state-icon">📋</div>
          <h3>No projects yet</h3>
          <p>Create your first systematic review project to get started.</p>
          <Link to="/projects/new" className="btn-primary btn-lg">
            <Plus size={15} /> Create first project
          </Link>
        </div>
      )}

      {/* Project grid */}
      <div className="project-grid">
        {projects?.map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="project-card"
            style={p.parent_project_id ? { borderLeft: "3px solid var(--brand)", opacity: 0.92 } : undefined}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              {p.parent_project_id && (
                <span
                  title="Sub-project"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--brand)",
                    background: "#ede9fe",
                    borderRadius: 4,
                    padding: "2px 6px",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  <GitBranch size={10} /> Sub-project
                </span>
              )}
            </div>
            {p.description && (
              <p className="project-card-desc">{p.description}</p>
            )}
            <div className="project-card-meta">
              <span style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
                <BookOpen size={12} />
                {p.record_count ?? 0} records
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
                <Calendar size={12} />
                {new Date(p.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
