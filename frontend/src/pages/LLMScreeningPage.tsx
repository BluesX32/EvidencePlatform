/**
 * LLMScreeningPage — Launch and review AI-assisted screening runs.
 *
 * The LLM screens ALL papers in parallel with the human workflow.
 * Human decisions are primary; this page surfaces LLM outputs for review so
 * researchers can spot themes or papers they may have missed.
 *
 * Layout:
 *   1. Estimate panel  — model selector, cost/time preview
 *   2. Run history     — list of past runs with status + progress
 *   3. Results panel   — paginated per-result table for the selected run
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronLeft, Play, RefreshCw, CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import {
  projectsApi,
  llmScreeningApi,
  type LlmRunResponse,
  type LlmResultResponse,
} from "../api/client";

// ── Constants ────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku (fastest, cheapest)",
    note: "~$0.25/1k articles · ~5 min/1k",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet (recommended)",
    note: "~$3/1k articles · ~12 min/1k",
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus (most thorough)",
    note: "~$15/1k articles · ~25 min/1k",
  },
];

const DECISION_FILTER_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "include", label: "Include" },
  { value: "exclude", label: "Exclude" },
  { value: "uncertain", label: "Uncertain" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function decisionBadge(decision: string | null) {
  if (!decision) return <span style={{ color: "#9aa0a6" }}>—</span>;
  const colors: Record<string, { bg: string; fg: string }> = {
    include:  { bg: "#e6f4ea", fg: "#188038" },
    exclude:  { bg: "#fce8e6", fg: "#c5221f" },
    uncertain:{ bg: "#fef7e0", fg: "#b06000" },
  };
  const c = colors[decision] ?? { bg: "#f1f3f4", fg: "#5f6368" };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontWeight: 600,
        padding: "0.15rem 0.55rem",
        borderRadius: "0.75rem",
        fontSize: "0.78rem",
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {decision}
    </span>
  );
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; color: string }> = {
    pending:   { label: "Pending",   color: "#9aa0a6" },
    running:   { label: "Running…",  color: "#1a73e8" },
    completed: { label: "Completed", color: "#188038" },
    failed:    { label: "Failed",    color: "#c5221f" },
  };
  const s = map[status] ?? { label: status, color: "#5f6368" };
  return <span style={{ color: s.color, fontWeight: 600, fontSize: "0.82rem" }}>{s.label}</span>;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        background: "#e8f0fe",
        borderRadius: "0.5rem",
        height: 6,
        width: 120,
        overflow: "hidden",
        display: "inline-block",
        verticalAlign: "middle",
      }}
    >
      <div
        style={{
          background: "#1a73e8",
          height: "100%",
          width: `${Math.min(pct, 100)}%`,
          borderRadius: "0.5rem",
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

function fmtCost(usd: number | null | undefined) {
  if (usd == null) return "—";
  return `$${usd.toFixed(4)}`;
}

function fmtMinutes(min: number) {
  if (min < 1) return `~${Math.round(min * 60)}s`;
  return `~${min.toFixed(1)} min`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// ── Review action buttons ─────────────────────────────────────────────────────

function ReviewActions({
  result,
  projectId,
  runId,
  onReviewed,
}: {
  result: LlmResultResponse;
  projectId: string;
  runId: string;
  onReviewed: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function handle(action: "accepted" | "rejected" | "merged") {
    setPending(true);
    try {
      await llmScreeningApi.reviewResult(projectId, runId, result.id, action);
      onReviewed();
    } finally {
      setPending(false);
    }
  }

  if (result.review_action) {
    const colors: Record<string, string> = {
      accepted: "#188038",
      rejected: "#c5221f",
      merged:   "#1a73e8",
    };
    return (
      <span
        style={{
          fontSize: "0.78rem",
          color: colors[result.review_action] ?? "#5f6368",
          fontWeight: 600,
          textTransform: "capitalize",
        }}
      >
        {result.review_action}
      </span>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.3rem" }}>
      <button
        title="Accept — LLM finding confirmed"
        disabled={pending}
        onClick={() => handle("accepted")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #b7dfc4",
          background: "#e6f4ea",
          color: "#188038",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Accept
      </button>
      <button
        title="Reject — LLM result not useful"
        disabled={pending}
        onClick={() => handle("rejected")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #f28b82",
          background: "#fce8e6",
          color: "#c5221f",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Reject
      </button>
      <button
        title="Merge — incorporate into human extraction"
        disabled={pending}
        onClick={() => handle("merged")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #c5d9f7",
          background: "#e8f0fe",
          color: "#1a73e8",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Merge
      </button>
    </div>
  );
}

// ── Result detail row ─────────────────────────────────────────────────────────

function ResultRow({
  result,
  projectId,
  runId,
  onReviewed,
}: {
  result: LlmResultResponse;
  projectId: string;
  runId: string;
  onReviewed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isNew = (result.new_concepts?.length ?? 0) > 0;

  return (
    <>
      <tr
        style={{
          background: isNew ? "rgba(79,70,229,0.04)" : undefined,
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <td style={{ fontSize: "0.8rem", color: "#9aa0a6", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {result.record_id?.slice(-8) ?? result.cluster_id?.slice(-8) ?? "—"}
        </td>
        <td>{decisionBadge(result.ta_decision)}</td>
        <td>{decisionBadge(result.ft_decision)}</td>
        <td style={{ fontSize: "0.8rem", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {result.ta_reason ?? "—"}
        </td>
        <td>
          {isNew ? (
            <span style={{ color: "#6366f1", fontWeight: 600, fontSize: "0.78rem" }}>
              +{result.new_concepts!.length} new
            </span>
          ) : (
            <span style={{ color: "#9aa0a6", fontSize: "0.78rem" }}>—</span>
          )}
        </td>
        <td style={{ fontSize: "0.78rem", color: "#5f6368" }}>
          {result.full_text_source ?? "abstract"}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <ReviewActions
            result={result}
            projectId={projectId}
            runId={runId}
            onReviewed={onReviewed}
          />
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "#f8f9fa" }}>
          <td colSpan={7} style={{ padding: "0.75rem 1rem", fontSize: "0.83rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              {result.ta_reason && (
                <div>
                  <strong style={{ color: "#3c4043" }}>TA reason:</strong>
                  <p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ta_reason}</p>
                </div>
              )}
              {result.ft_reason && (
                <div>
                  <strong style={{ color: "#3c4043" }}>FT reason:</strong>
                  <p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ft_reason}</p>
                </div>
              )}
              {(result.matched_codes?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#3c4043" }}>Matched concepts:</strong>
                  <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                    {result.matched_codes!.map((c) => (
                      <span
                        key={c}
                        style={{
                          background: "#e8f0fe",
                          color: "#1a73e8",
                          padding: "0.15rem 0.55rem",
                          borderRadius: "0.75rem",
                          fontSize: "0.78rem",
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(result.new_concepts?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#6366f1" }}>New concepts suggested:</strong>
                  <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                    {result.new_concepts!.map((c) => (
                      <span
                        key={c}
                        style={{
                          background: "#ede9fe",
                          color: "#6366f1",
                          padding: "0.15rem 0.55rem",
                          borderRadius: "0.75rem",
                          fontSize: "0.78rem",
                          fontWeight: 600,
                        }}
                      >
                        + {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Results panel ─────────────────────────────────────────────────────────────

function ResultsPanel({
  projectId,
  run,
}: {
  projectId: string;
  run: LlmRunResponse;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [decisionFilter, setDecisionFilter] = useState("");
  const PAGE_SIZE = 50;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["llm-results", run.id, page, decisionFilter],
    queryFn: () =>
      llmScreeningApi
        .listResults(projectId, run.id, {
          page,
          page_size: PAGE_SIZE,
          ta_decision: decisionFilter || undefined,
        })
        .then((r) => r.data),
    enabled: run.status === "completed" || run.processed_records > 0,
    staleTime: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  const newConceptsCount = data?.items.reduce(
    (acc, r) => acc + (r.new_concepts?.length ?? 0),
    0
  ) ?? 0;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>Results</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {DECISION_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setDecisionFilter(opt.value); setPage(1); }}
              style={{
                padding: "0.2rem 0.65rem",
                borderRadius: "0.75rem",
                border: `1.5px solid ${decisionFilter === opt.value ? "#1a73e8" : "#dadce0"}`,
                background: decisionFilter === opt.value ? "#e8f0fe" : "#f8f9fa",
                color: decisionFilter === opt.value ? "#1a73e8" : "#5f6368",
                fontSize: "0.8rem",
                fontWeight: decisionFilter === opt.value ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => { void refetch(); }}
          className="btn-ghost"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.35rem" }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: "flex",
          gap: "1.5rem",
          background: "#f8f9fa",
          border: "1px solid #dadce0",
          borderRadius: "0.5rem",
          padding: "0.65rem 1rem",
          marginBottom: "1rem",
          fontSize: "0.85rem",
          flexWrap: "wrap",
        }}
      >
        <span>
          <strong style={{ color: "#188038" }}>{run.included_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>included</span>
        </span>
        <span>
          <strong style={{ color: "#c5221f" }}>{run.excluded_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>excluded</span>
        </span>
        <span>
          <strong style={{ color: "#b06000" }}>{run.uncertain_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>uncertain</span>
        </span>
        {run.new_concepts_count > 0 && (
          <span>
            <strong style={{ color: "#6366f1" }}>{run.new_concepts_count}</strong>{" "}
            <span style={{ color: "#5f6368" }}>new concepts suggested</span>
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "#5f6368" }}>
          {fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)} actual cost ·{" "}
          {(run.input_tokens + run.output_tokens).toLocaleString()} tokens
        </span>
      </div>

      {isLoading ? (
        <p style={{ color: "#5f6368" }}>Loading results…</p>
      ) : !data || data.items.length === 0 ? (
        <p style={{ color: "#9aa0a6", fontStyle: "italic" }}>
          {run.status === "running" ? "Processing — results will appear as they complete." : "No results match the current filter."}
        </p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f1f3f4", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#5f6368" }}>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Record ID</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>TA</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>FT</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Reason</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>New Concepts</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Full Text</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Review</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((result) => (
                  <ResultRow
                    key={result.id}
                    result={result}
                    projectId={projectId}
                    runId={run.id}
                    onReviewed={() => {
                      qc.invalidateQueries({ queryKey: ["llm-results", run.id] });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                justifyContent: "center",
                marginTop: "1rem",
                fontSize: "0.85rem",
              }}
            >
              <button
                className="btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Prev
              </button>
              <span style={{ color: "#5f6368" }}>
                Page {page} of {totalPages} ({data.total.toLocaleString()} results)
              </span>
              <button
                className="btn-ghost"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LLMScreeningPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4-6");
  const [selectedRun, setSelectedRun] = useState<LlmRunResponse | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // ── Project ────────────────────────────────────────────────────────────────

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // ── Estimate ───────────────────────────────────────────────────────────────

  const { data: estimate, isLoading: estimateLoading, refetch: refetchEstimate } = useQuery({
    queryKey: ["llm-estimate", projectId, selectedModel],
    queryFn: () =>
      llmScreeningApi.estimate(projectId!, selectedModel).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // ── Run list ───────────────────────────────────────────────────────────────

  const { data: runs, refetch: refetchRuns } = useQuery({
    queryKey: ["llm-runs", projectId],
    queryFn: () => llmScreeningApi.listRuns(projectId!).then((r) => r.data),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((r) => r.status === "running" || r.status === "pending")
        ? 3000
        : false;
    },
  });

  // Keep selectedRun in sync with live data
  useEffect(() => {
    if (selectedRun && runs) {
      const updated = runs.find((r) => r.id === selectedRun.id);
      if (updated) setSelectedRun(updated);
    }
  }, [runs]);

  // ── Poll running run ───────────────────────────────────────────────────────

  const runningRun = runs?.find((r) => r.status === "running" || r.status === "pending");

  const { data: liveRun } = useQuery({
    queryKey: ["llm-run-live", runningRun?.id],
    queryFn: () =>
      llmScreeningApi.getRun(projectId!, runningRun!.id).then((r) => r.data),
    enabled: !!runningRun,
    refetchInterval: 3000,
  });

  // Merge live data back into runs list display
  const displayRuns = runs?.map((r) =>
    liveRun && r.id === liveRun.id ? liveRun : r
  );

  // ── Launch mutation ────────────────────────────────────────────────────────

  const launch = useMutation({
    mutationFn: () => llmScreeningApi.createRun(projectId!, selectedModel),
    onSuccess: (res) => {
      setLaunchError(null);
      qc.invalidateQueries({ queryKey: ["llm-runs", projectId] });
      setSelectedRun(res.data);
    },
    onError: (err: any) => {
      const detail = err.response?.data?.detail ?? "Failed to launch run";
      setLaunchError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  const hasRunningRun = !!runningRun;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          <ChevronLeft size={15} /> {project?.name ?? "Project"}
        </Link>
      </header>

      <main>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "0.5rem",
          }}
        >
          <Bot size={22} style={{ color: "#6366f1" }} />
          <h2 style={{ margin: 0 }}>LLM Screening</h2>
        </div>
        <p className="muted" style={{ marginBottom: "2rem", maxWidth: 640 }}>
          Run an AI screening pass over all papers in parallel with the human workflow.
          The LLM reads each paper (using full text where available), applies your
          inclusion/exclusion criteria, and flags any themes or concepts not yet in
          your codebook. Human decisions remain primary — use this panel to review
          and selectively incorporate LLM findings.
        </p>

        {/* ── Cost estimate ────────────────────────────────────────────────── */}
        <section
          style={{
            background: "#f8f9fa",
            border: "1px solid #dadce0",
            borderRadius: "0.5rem",
            padding: "1.25rem",
            marginBottom: "2rem",
            maxWidth: 680,
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>Cost & time estimate</h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
              <label
                style={{ fontSize: "0.85rem", fontWeight: 500, marginBottom: "0.35rem", display: "block" }}
              >
                Model
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{ fontSize: "0.9rem", padding: "0.4rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", minWidth: 280 }}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="muted" style={{ marginTop: "0.25rem", fontSize: "0.8rem" }}>
                {MODELS.find((m) => m.id === selectedModel)?.note}
              </p>
            </div>

            {estimateLoading ? (
              <p style={{ color: "#9aa0a6", fontSize: "0.88rem" }}>Calculating estimate…</p>
            ) : estimate ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "1rem",
                }}
              >
                <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem" }}>
                  <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "#3c4043" }}>
                    {estimate.total_records.toLocaleString()}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#5f6368", marginTop: "0.15rem" }}>papers to screen</div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem" }}>
                  <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "#3c4043" }}>
                    {fmtCost(estimate.estimated_cost_usd)}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#5f6368", marginTop: "0.15rem" }}>estimated cost</div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem" }}>
                  <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "#3c4043" }}>
                    {fmtMinutes(estimate.estimated_minutes)}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#5f6368", marginTop: "0.15rem" }}>estimated time</div>
                </div>
              </div>
            ) : null}

            {/* Cost breakdown */}
            {estimate && (
              <div style={{ fontSize: "0.78rem", color: "#5f6368" }}>
                {estimate.estimated_input_tokens.toLocaleString()} input tokens ·{" "}
                {estimate.estimated_output_tokens.toLocaleString()} output tokens
                {estimate.cost_breakdown &&
                  Object.entries(estimate.cost_breakdown).map(([k, v]) => (
                    <span key={k}> · {k}: {fmtCost(v)}</span>
                  ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              className="btn-primary"
              disabled={launch.isPending || hasRunningRun || (estimate?.total_records ?? 0) === 0}
              onClick={() => launch.mutate()}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <Play size={15} />
              {launch.isPending ? "Launching…" : "Launch LLM screening run"}
            </button>
            {hasRunningRun && (
              <span style={{ color: "#1a73e8", fontSize: "0.85rem" }}>
                A run is already in progress.
              </span>
            )}
            {(estimate?.total_records ?? 0) === 0 && !hasRunningRun && (
              <span style={{ color: "#9aa0a6", fontSize: "0.85rem" }}>
                Import records first.
              </span>
            )}
          </div>
          {launchError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {launchError}
            </p>
          )}
        </section>

        {/* ── Run history ───────────────────────────────────────────────────── */}
        <section style={{ marginBottom: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem" }}>
            <h3 style={{ margin: 0 }}>Run history</h3>
            <button
              className="btn-ghost"
              onClick={() => void refetchRuns()}
              style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {!displayRuns || displayRuns.length === 0 ? (
            <p className="muted">No runs yet. Launch your first LLM screening run above.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.85rem",
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "#f1f3f4",
                      fontSize: "0.78rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "#5f6368",
                    }}
                  >
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Started</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Model</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Status</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Progress</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Include</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Exclude</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Uncertain</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>New Concepts</th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRuns.map((run) => {
                    const isSelected = selectedRun?.id === run.id;
                    return (
                      <tr
                        key={run.id}
                        onClick={() => setSelectedRun(isSelected ? null : run)}
                        style={{
                          cursor: "pointer",
                          background: isSelected ? "#e8f0fe" : undefined,
                          borderLeft: isSelected ? "3px solid #1a73e8" : "3px solid transparent",
                        }}
                      >
                        <td style={{ padding: "0.55rem 0.75rem" }}>{fmtDate(run.started_at ?? run.created_at)}</td>
                        <td style={{ padding: "0.55rem 0.75rem", color: "#5f6368", fontSize: "0.78rem" }}>
                          {run.model.replace("claude-", "").replace(/-\d{10}$/, "")}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem" }}>
                          {statusBadge(run.status)}
                          {run.error_message && (
                            <span title={run.error_message} style={{ marginLeft: "0.35rem", cursor: "help" }}>
                              ⚠
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem" }}>
                          {run.status === "running" || run.status === "pending" ? (
                            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                              <ProgressBar pct={run.progress_pct} />
                              <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>
                                {run.progress_pct.toFixed(1)}%
                              </span>
                            </span>
                          ) : (
                            <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>
                              {run.processed_records.toLocaleString()} / {(run.total_records ?? 0).toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#188038", fontWeight: 600 }}>
                          {run.included_count}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#c5221f", fontWeight: 600 }}>
                          {run.excluded_count}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#b06000", fontWeight: 600 }}>
                          {run.uncertain_count}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>
                          {run.new_concepts_count > 0 ? `+${run.new_concepts_count}` : "—"}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", fontSize: "0.82rem", color: "#5f6368" }}>
                          {fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Results for selected run ───────────────────────────────────────── */}
        {selectedRun && projectId && (
          <ResultsPanel projectId={projectId} run={selectedRun} />
        )}
      </main>
    </div>
  );
}
