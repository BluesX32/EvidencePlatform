import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { importsApi, sourcesApi } from "../api/client";
import type { ImportJob } from "../api/client";
import ImportProgress from "../components/ImportProgress";

export default function ImportPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");

  const { data: sources } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => sourcesApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });

  function validateFile(f: File): string | null {
    if (!f.name.toLowerCase().endsWith(".ris")) {
      return "Only .ris files are supported";
    }
    if (f.size > 50 * 1024 * 1024) {
      return "File exceeds 50 MB limit";
    }
    return null;
  }

  function handleFileSelect(f: File) {
    const err = validateFile(f);
    if (err) {
      setError(err);
      setFile(null);
    } else {
      setError(null);
      setFile(f);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  }

  async function handleUpload() {
    if (!file || !projectId) return;
    setUploading(true);
    setError(null);
    try {
      const res = await importsApi.start(projectId, file, selectedSourceId || undefined);
      setJobId(res.data.import_job_id);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Upload failed");
      setUploading(false);
    }
  }

  function onComplete(job: ImportJob) {
    if (job.status === "completed") {
      setTimeout(() => navigate(`/projects/${projectId}/records`), 1500);
    }
  }

  const hasSources = sources && sources.length > 0;

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
      </header>
      <main>
        <h2>Import literature</h2>
        <p className="muted">Upload a .ris file exported from PubMed, Scopus, or any database supporting RIS format.</p>

        {!jobId ? (
          <>
            {/* Source selector */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label className="label" htmlFor="source-select">
                Source database
              </label>
              {hasSources ? (
                <select
                  id="source-select"
                  className="input"
                  value={selectedSourceId}
                  onChange={(e) => setSelectedSourceId(e.target.value)}
                  style={{ display: "block", marginTop: "0.4rem", maxWidth: 300 }}
                >
                  <option value="">— Select a source —</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              ) : (
                <p className="muted" style={{ marginTop: "0.4rem" }}>
                  No sources defined yet.{" "}
                  <Link to={`/projects/${projectId}`}>Add a source</Link> on the project page before importing.
                </p>
              )}
            </div>

            <div
              className={`upload-zone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".ris"
                style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
              />
              {file ? (
                <div>
                  <p className="file-name">📄 {file.name}</p>
                  <p className="muted">{(file.size / 1024).toFixed(0)} KB</p>
                </div>
              ) : (
                <div>
                  <p>Drop a .ris file here or click to select</p>
                  <p className="muted">Maximum 50 MB</p>
                </div>
              )}
            </div>

            {error && <p className="error">{error}</p>}

            <div className="form-actions">
              <Link to={`/projects/${projectId}`} className="btn-ghost">Cancel</Link>
              <button
                className="btn-primary"
                onClick={handleUpload}
                disabled={!file || uploading || !hasSources || !selectedSourceId}
              >
                {uploading ? "Uploading…" : "Import"}
              </button>
            </div>
          </>
        ) : (
          <ImportProgress projectId={projectId!} jobId={jobId} onComplete={onComplete} />
        )}
      </main>
    </div>
  );
}
