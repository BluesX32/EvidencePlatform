import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { projectsApi } from "../api/client";

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await projectsApi.create(name.trim(), description.trim() || undefined);
      navigate(`/projects/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
      </header>
      <main>
        <h2>New project</h2>
        <form onSubmit={handleSubmit} className="form-card">
          <div className="field">
            <label htmlFor="name">Project name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mindfulness interventions for depression"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="description">Description (optional)</label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Brief description of the review scope"
            />
          </div>
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <Link to="/projects" className="btn-ghost">Cancel</Link>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
