import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Square, Eye } from "lucide-react";
import { aiPilotApi, type AiBatchJob } from "../api/client";

/** Stop button for a running AI Pilot batch job (extract/concepts/resolve_conflicts). */
export function StopJobButton({
  projectId, jobId, onStopped, statusQueryKey,
}: { projectId: string; jobId: string; onStopped?: () => void; statusQueryKey?: unknown[] }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => aiPilotApi.stopJob(projectId, jobId),
    onSuccess: () => {
      if (statusQueryKey) qc.invalidateQueries({ queryKey: statusQueryKey });
      onStopped?.();
    },
  });
  return (
    <button
      onClick={() => stop.mutate()}
      disabled={stop.isPending}
      title="Stop this run — remaining work is picked up next time you start it again"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "0.3rem 0.6rem", borderRadius: "0.375rem",
        border: "1px solid #fca5a5", background: "#fef2f2", color: "#c5221f",
        fontSize: "0.78rem", fontWeight: 600, cursor: stop.isPending ? "default" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {stop.isPending ? <Loader2 size={12} className="spin" /> : <Square size={11} fill="#c5221f" />}
      Stop
    </button>
  );
}

/** Always-visible "View AI Results" button + modal, for any AI Pilot job type. */
export function ViewResultsButton({
  projectId, jobId, disabled,
}: { projectId: string; jobId?: string | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={!jobId || disabled}
        title={jobId ? "View what this AI run produced" : "No AI run yet"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "0.3rem 0.6rem", borderRadius: "0.375rem",
          border: "1px solid var(--border)", background: "var(--surface)",
          color: !jobId || disabled ? "#9ca3af" : "var(--text)",
          fontSize: "0.78rem", fontWeight: 600, cursor: !jobId || disabled ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <Eye size={12} /> View AI Results
      </button>
      {open && jobId && (
        <AiResultsModal projectId={projectId} jobId={jobId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function fmtStatus(job: AiBatchJob): string {
  if (job.status === "running") return `Running — ${job.done ?? 0} / ${job.total ?? "?"}`;
  if (job.status === "stopped") return `Stopped — ${job.done ?? 0} / ${job.total ?? "?"} completed before stopping`;
  if (job.status === "failed") return `Failed${job.error ? `: ${job.error}` : ""}`;
  if (job.status === "done") return `Done — ${job.done ?? 0} processed${job.errors ? `, ${job.errors} error(s)` : ""}`;
  return job.status;
}

function AiResultsModal({
  projectId, jobId, onClose,
}: { projectId: string; jobId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-job-results", projectId, jobId],
    queryFn: () => aiPilotApi.getJobResults(projectId, jobId).then((r) => r.data),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">AI Results</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        {isLoading || !data ? (
          <div style={{ padding: "1rem", textAlign: "center" }}><Loader2 size={18} className="spin" /></div>
        ) : (
          <div style={{ fontSize: "0.85rem" }}>
            <p style={{ color: "var(--text-muted)", marginBottom: "0.75rem" }}>{fmtStatus(data.job)}</p>

            {data.items !== null ? (
              data.items.length === 0 ? (
                <p style={{ color: "var(--text-muted)" }}>
                  {(data.job.done ?? 0) > 0
                    ? `${data.job.done} item(s) were processed but none produced a result. This usually means the model's ` +
                      "response didn't parse (e.g. it was cut off for a large template, or hit an error) — check the " +
                      "model/API key, try a smaller template, or a stronger model, then run again to pick up where this left off."
                    : "No items produced yet."}
                </p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {data.items.map((item, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "0.4rem 0.5rem 0.4rem 0", maxWidth: 380 }}>
                          <div style={{ fontWeight: 500 }}>{item.title ?? "(untitled)"}</div>
                          {item.stage && item.decision && (
                            <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                              {item.stage}: {item.decision}{item.notes ? ` — ${item.notes}` : ""}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "0.4rem 0", color: "var(--text-muted)", fontSize: "0.75rem", whiteSpace: "nowrap", textAlign: "right" }}>
                          {new Date(item.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : data.job.result ? (
              <pre style={{
                background: "#f8f9fa", padding: "0.75rem", borderRadius: "0.375rem",
                fontSize: "0.78rem", overflowX: "auto", whiteSpace: "pre-wrap",
              }}>
                {JSON.stringify(data.job.result, null, 2)}
              </pre>
            ) : (
              <p style={{ color: "var(--text-muted)" }}>No result recorded for this run.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
