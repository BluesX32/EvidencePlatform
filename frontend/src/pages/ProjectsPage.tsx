import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, BookOpen, Calendar, GitBranch, FolderOpen } from "lucide-react";
import { projectsApi } from "../api/client";
import type { ProjectListItem } from "../api/client";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ParentCard({ p, children }: { p: ProjectListItem; children: ProjectListItem[] }) {
  return (
    <div className="project-tree-group">
      {/* Parent card */}
      <Link to={`/projects/${p.id}`} className="project-card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <FolderOpen size={15} style={{ color: "var(--brand)", flexShrink: 0 }} />
            <h3 style={{ margin: 0 }}>{p.name}</h3>
          </div>
          {children.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", background: "#ede9fe", borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap", flexShrink: 0 }}>
              {children.length} sub-project{children.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {p.description && <p className="project-card-desc">{p.description}</p>}
        <div className="project-card-meta">
          <span style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
            <BookOpen size={12} /> {p.record_count ?? 0} records
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: ".3rem" }}>
            <Calendar size={12} /> {fmtDate(p.created_at)}
          </span>
        </div>
      </Link>

      {/* Sub-project rows */}
      {children.length > 0 && (
        <div className="project-children">
          {children.map((child, i) => (
            <div key={child.id} className="project-child-row">
              {/* Tree connector */}
              <div className="project-tree-line" aria-hidden>
                <div className="project-tree-vert" style={{ height: i === children.length - 1 ? "50%" : "100%" }} />
                <div className="project-tree-horiz" />
              </div>

              <Link to={`/projects/${child.id}`} className="project-child-card">
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <GitBranch size={12} style={{ color: "var(--brand)", flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{child.name}</span>
                </div>
                {child.description && (
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {child.description}
                  </p>
                )}
                <div style={{ display: "flex", gap: "1rem", fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: ".25rem" }}>
                    <BookOpen size={11} /> {child.record_count ?? 0} records
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: ".25rem" }}>
                    <Calendar size={11} /> {fmtDate(child.created_at)}
                  </span>
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list().then((r) => r.data),
  });

  // Build parent → children map
  const childrenByParent = new Map<string, ProjectListItem[]>();
  const childIds = new Set<string>();

  projects?.forEach((p) => {
    if (p.parent_project_id) {
      childIds.add(p.id);
      const arr = childrenByParent.get(p.parent_project_id) ?? [];
      arr.push(p);
      childrenByParent.set(p.parent_project_id, arr);
    }
  });

  // Top-level = not a child of anything
  const topLevel = projects?.filter((p) => !childIds.has(p.id)) ?? [];

  // Sort: parents with children first, then standalone projects
  topLevel.sort((a, b) => {
    const aHasKids = (childrenByParent.get(a.id)?.length ?? 0) > 0;
    const bHasKids = (childrenByParent.get(b.id)?.length ?? 0) > 0;
    if (aHasKids && !bHasKids) return -1;
    if (!aHasKids && bHasKids) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="page">
      <div className="projects-header">
        <div>
          <h1 style={{ marginBottom: ".2rem" }}>Projects</h1>
          <p className="muted" style={{ margin: 0 }}>Manage your systematic review projects</p>
        </div>
        <Link to="/projects/new" className="btn-primary btn-lg">
          <Plus size={18} /> New project
        </Link>
      </div>

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

      <div className="project-tree-list">
        {topLevel.map((p) => (
          <ParentCard
            key={p.id}
            p={p}
            children={childrenByParent.get(p.id) ?? []}
          />
        ))}
      </div>
    </div>
  );
}
