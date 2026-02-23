import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { projectsApi, importsApi } from "../api/client";
import type { ImportJob } from "../api/client";

function statusBadge(status: ImportJob["status"]) {
  const colors: Record<string, string> = {
    pending: "#888",
    processing: "#1a73e8",
    completed: "#188038",
    failed: "#c5221f",
  };
  return (
    <span style={{ color: colors[status] ?? "#888", fontWeight: 600 }}>
      {status}
    </span>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();

  const { data: project, isLoading: loadingProject } = useQuery({
    queryKey: ["project", id],
    queryFn: () => projectsApi.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: jobs } = useQuery({
    queryKey: ["imports", id],
    queryFn: () => importsApi.list(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const hasActive = data.some((j) => j.status === "pending" || j.status === "processing");
      return hasActive ? 1500 : false;
    },
  });

  if (loadingProject) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
      </header>
      <main>
        <div className="project-hero">
          <h2>{project?.name}</h2>
          {project?.description && <p>{project.description}</p>}
          <div className="project-stats">
            <span><strong>{project?.record_count ?? 0}</strong> records</span>
            <span><strong>{project?.import_count ?? 0}</strong> imports</span>
          </div>
        </div>

        <div className="action-bar">
          <Link to={`/projects/${id}/import`} className="btn-primary">Import literature</Link>
          {(project?.record_count ?? 0) > 0 && (
            <Link to={`/projects/${id}/records`} className="btn-secondary">View records</Link>
          )}
        </div>

        <section>
          <h3>Import history</h3>
          {!jobs || jobs.length === 0 ? (
            <p className="muted">No imports yet. Upload a RIS file to get started.</p>
          ) : (
            <table className="import-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Status</th>
                  <th>Records</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.filename}</td>
                    <td>{statusBadge(job.status)}</td>
                    <td>{job.record_count ?? "—"}</td>
                    <td>{new Date(job.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
