import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { importsApi } from "../api/client";
import type { ImportJob } from "../api/client";

interface Props {
  projectId: string;
  jobId: string;
  onComplete: (job: ImportJob) => void;
}

export default function ImportProgress({ projectId, jobId, onComplete }: Props) {
  const { data: job } = useQuery({
    queryKey: ["import-job", jobId],
    queryFn: () => importsApi.get(projectId, jobId).then((r) => r.data),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "completed" || s === "failed" ? false : 1000;
    },
  });

  useEffect(() => {
    if (job?.status === "completed" || job?.status === "failed") {
      onComplete(job);
    }
  }, [job?.status]);

  return (
    <div className="import-progress">
      {!job || job.status === "pending" || job.status === "processing" ? (
        <div className="spinner-container">
          <div className="spinner" />
          <p>Importing {job?.filename ?? "file"}…</p>
        </div>
      ) : job.status === "completed" ? (
        <div className="import-success">
          <p className="success">✓ Import complete</p>
          <p><strong>{job.record_count}</strong> records imported from {job.filename}</p>
          <Link to={`/projects/${projectId}/records`} className="btn-primary">
            View records
          </Link>
        </div>
      ) : (
        <div>
          <p className="error">Import failed</p>
          <p className="muted">{job.error_msg}</p>
          <Link to={`/projects/${projectId}/import`} className="btn-ghost">Try again</Link>
        </div>
      )}
    </div>
  );
}
