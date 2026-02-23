import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { projectsApi, clearToken } from "../api/client";

export default function ProjectsPage() {
  const navigate = useNavigate();

  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list().then((r) => r.data),
  });

  function logout() {
    clearToken();
    navigate("/login");
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>EvidencePlatform</h1>
        <div className="header-actions">
          <Link to="/projects/new" className="btn-primary">New project</Link>
          <button onClick={logout} className="btn-ghost">Sign out</button>
        </div>
      </header>

      <main>
        <h2>Your projects</h2>
        {isLoading && <p>Loading…</p>}
        {error && <p className="error">Failed to load projects</p>}
        {projects?.length === 0 && (
          <div className="empty-state">
            <p>No projects yet.</p>
            <Link to="/projects/new" className="btn-primary">Create your first project</Link>
          </div>
        )}
        <div className="project-grid">
          {projects?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="project-card">
              <h3>{p.name}</h3>
              {p.description && <p className="description">{p.description}</p>}
              <div className="project-meta">
                <span>{p.record_count} records</span>
                <span>{new Date(p.created_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
